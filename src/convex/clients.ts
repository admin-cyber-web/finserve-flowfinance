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
import { idQueryMatches } from "../lib/server/idMatch";
import {
  centerReportRows,
  createCenterForActor,
  resolveCenterForClient,
} from "../lib/server/centerOps";
import {
  ageFromDob,
  mobileNumber,
  optionalString,
  requiredString,
  intInRange,
  money,
  oneOf,
  loanRequestValue,
  bankAccountValue,
  nomineeValue,
  referencesValue,
} from "../lib/finance/validate";
import { rowOutstanding } from "../lib/finance/schedule";
import {
  KYC_STATUS,
  DOC_STATUS,
  OFFICE_VERIFICATION,
  OFFICE_KYC,
  OFFICE_CREDIT,
} from "../lib/finance/types";
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
    /** Default hides removed (INACTIVE) clients — pass true to include them. */
    includeInactive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    requirePermission(me, "view_clients");

    let clients = await visibleClients(ctx, me, {
      staffId: args.staffId ?? null,
      branchId: args.branchId ?? null,
    });
    if (!args.includeInactive) {
      clients = clients.filter((c) => c.status !== "INACTIVE");
    }
    if (args.kycStatus) clients = clients.filter((c) => c.kycStatus === args.kycStatus);

    const q = (args.search ?? "").trim().toLowerCase();
    if (q) {
      const digits = q.replace(/\D/g, "");
      clients = clients.filter(
        (c) =>
          c.searchText.includes(q) ||
          (digits.length >= 3 && c.mobile.includes(digits)) ||
          c.code.toLowerCase().startsWith(q) ||
          // Numeric / prefixed / hyphen-less forms of the Client ID
          // ("000137", "C-000137", "C000137") all resolve to the record.
          idQueryMatches(c.code, args.search ?? ""),
      );
    }
    clients = clients.sort((a, b) => b.createdAt - a.createdAt);
    if (args.limit) clients = clients.slice(0, args.limit);

    const loans = await ctx.db.query("loans").collect();
    const profiles = await ctx.db.query("profiles").collect();
    const staffById = new Map(profiles.map((p) => [p._id, p]));
    const centers = await ctx.db.query("centers").collect();
    const centerNameByCode = new Map(centers.map((c) => [c.code, c.name]));

    return clients.map((c) => {
      const mine = loans.filter((l) => l.clientId === c._id);
      const active = mine.filter((l) => ["ACTIVE", "OVERDUE"].includes(l.status));
      const overdue = mine.filter((l) => l.status === "OVERDUE");
      return {
        ...c,
        staffName: staffById.get(c.assignedTo)?.name ?? "—",
        centerName: c.centerCode ? (centerNameByCode.get(c.centerCode) ?? null) : null,
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
    // Structured family rows from the application form (legacy clients have
    // only the numeric count on the client document).
    const family = (await ctx.db.query("clientFamilyMembers").collect())
      .filter((f) => f.clientId === clientId)
      .sort((a, b) => a.createdAt - b.createdAt);
    // Signed URL for the optional co-applicant photo (same access checks as
    // the rest of this query — never a permanent public link).
    const coApplicantPhotoUrl = client.coApplicant?.photoStorageId
      ? await ctx.storage.getUrl(client.coApplicant.photoStorageId)
      : null;
    const recovery = (await ctx.db.query("recoveryActivities").collect())
      .filter((r) => r.clientId === clientId)
      .sort((a, b) => b.createdAt - a.createdAt);
    const grievances = (await ctx.db.query("grievances").collect())
      .filter((g) => g.clientId === clientId)
      .sort((a, b) => b.createdAt - a.createdAt);

    const profiles = await ctx.db.query("profiles").collect();
    const byId = new Map(profiles.map((p) => [p._id, p]));
    const branches = await ctx.db.query("branches").collect();
    const products = await ctx.db.query("loanProducts").collect();
    const branch = branches.find((b) => b._id === client.branchId) ?? null;
    const branchManager =
      profiles.find(
        (p) => p.role === "BRANCH_MANAGER" && p.branchId === client.branchId,
      ) ?? null;
    // Loan applications for this client — the source of "requested amount"
    // and application dates (never conflated with approved/disbursed).
    const applications = (
      await ctx.db
        .query("loanApplications")
        .withIndex("by_client", (q) => q.eq("clientId", clientId))
        .collect()
    ).sort((a, b) => b.createdAt - a.createdAt);

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
        if (rowOutstanding(row) > 0 && row.dueDate < now) {
          overdueAmount += rowOutstanding(row);
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
      family,
      coApplicantPhotoUrl,
      assignedStaff: byId.get(client.assignedTo) ?? null,
      createdBy: byId.get(client.createdBy) ?? null,
      branch,
      branchManager,
      applications,
      loans: loans.map((l) => ({
        loan: l,
        product: null,
        rows: schedules[l.loanId] ?? [],
        staffName: byId.get(l.staffId)?.name ?? null,
        productName: products.find((p) => p._id === l.productId)?.name ?? null,
        approvedByName: l.approvedBy ? (byId.get(l.approvedBy)?.name ?? null) : null,
        disbursedByName: l.disbursedBy ? (byId.get(l.disbursedBy)?.name ?? null) : null,
        branchName: branches.find((b) => b._id === l.branchId)?.name ?? null,
        branchManagerName:
          profiles.find(
            (p) => p.role === "BRANCH_MANAGER" && p.branchId === l.branchId,
          )?.name ?? null,
      })),
      payments: payments.map((p) => ({
        ...p,
        staffName: byId.get(p.staffId)?.name ?? null,
      })),
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

/** One uploaded KYC document reference passed to `create`. */
type UploadedDocArg = {
  docKind: string;
  fileName: string;
  storageId: Id<"_storage">;
};

type ValidatedKycDoc = {
  docKind: string;
  fileName: string;
  storageId: Id<"_storage">;
  sizeBytes: number;
  mimeType: string;
};

/**
 * Validate uploaded KYC document files against storage metadata: kind
 * (Aadhaar / PAN / Voter ID / Other), MIME type and size — the same rules
 * the capture UI enforces before uploading. On rejection EVERY file in
 * `docs` is deleted and an AppError is thrown, so a failed submission never
 * leaves orphaned files behind (the mutation itself rolls back, so no
 * half-created application remains either).
 *
 * Used for BOTH the applicant's documents and the co-applicant's documents:
 * both are normal captures with no geo-tagging, and each set is inserted
 * against the correct side of the application by the caller.
 */
async function validateUploadedKycDocs(
  ctx: { db: any; storage: any },
  docs: UploadedDocArg[],
  subject: string, // "Applicant document" | "Co-applicant document"
): Promise<ValidatedKycDoc[]> {
  const MAX_DOC_BYTES = 5 * 1024 * 1024;
  const allowedTypes = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
  const kinds = ["AADHAAR", "PAN", "VOTER_ID", "OTHER"];
  const validated: ValidatedKycDoc[] = [];
  let error: string | null = null;
  for (const d of docs) {
    if (error) break;
    if (!kinds.includes(d.docKind)) {
      error = `${subject} type must be Aadhaar, PAN, Voter ID or Other.`;
      break;
    }
    let fileName: string;
    try {
      fileName = requiredString(d.fileName, `${subject} file name`, 120);
    } catch {
      error = `${subject} has an invalid file name.`;
      break;
    }
    const meta = await ctx.db.system.get("_storage", d.storageId);
    if (!meta) {
      error = `${subject} file is missing — upload it again.`;
      break;
    }
    if (!meta.contentType || !allowedTypes.includes(meta.contentType)) {
      error = `${subject}s must be JPEG, PNG, WebP or PDF files.`;
      break;
    }
    if (meta.size <= 0 || meta.size > MAX_DOC_BYTES) {
      error = `${subject}s must be between 1 byte and ${Math.round(MAX_DOC_BYTES / 1024 / 1024)} MB.`;
      break;
    }
    validated.push({
      docKind: d.docKind,
      fileName,
      storageId: d.storageId,
      sizeBytes: meta.size,
      mimeType: meta.contentType,
    });
  }
  if (error) {
    for (const d of docs) {
      try {
        await ctx.storage.delete(d.storageId);
      } catch {
        // already gone — the thrown AppError below is what matters
      }
    }
    throw new AppError(error);
  }
  return validated;
}

export const create = mutation({
  args: {
    name: v.string(),
    fatherName: v.optional(v.string()),
    applicantFatherName: v.optional(v.string()),
    husbandName: v.optional(v.string()),
    fatherAddress: v.optional(v.string()),
    maternalHomeAddress: v.optional(v.string()),
    // Date of birth is REQUIRED for every new client — age is always
    // re-derived from it server-side (see handler).
    dob: v.number(),
    age: v.number(), // accepted for compatibility, never trusted — derived from `dob`
    gender: v.string(),
    mobile: v.string(),
    altMobile: v.optional(v.string()),
    address: v.optional(v.string()), // permanent address (full text)
    village: v.optional(v.string()), // derived from address when omitted
    district: v.optional(v.string()),
    state: v.optional(v.string()),
    pin: v.optional(v.string()),
    occupation: v.string(),
    typeOfBusiness: v.optional(v.string()),
    businessAddress: v.optional(v.string()),
    monthlyIncome: v.number(),
    householdIncome: v.number(),
    householdExpenses: v.optional(v.number()),
    otherIncome: v.optional(v.number()),
    existingLoanEmi: v.optional(v.number()),
    familyMembers: v.optional(v.number()), // legacy count — rows are truth
    familyRows: v.optional(
      v.array(
        v.object({
          name: v.string(),
          age: v.optional(v.number()),
          relationship: v.string(),
          occupation: v.optional(v.string()),
        }),
      ),
    ),
    panNumber: v.optional(v.string()),
    voterId: v.optional(v.string()),
    kycDocuments: v.optional(v.array(v.string())),
    // Applicant KYC document photos/files (Aadhaar/PAN/Voter/Other) —
    // NORMAL captures with NO geo-tagging. Each file is uploaded to private
    // storage before this mutation runs and re-validated from storage
    // metadata inside the handler. Rows land on `clientDocuments` for this
    // applicant; co-applicant files travel under coApplicant.documents.
    documents: v.optional(
      v.array(
        v.object({
          docKind: v.string(),
          fileName: v.string(),
          storageId: v.id("_storage"),
        }),
      ),
    ),
    coApplicant: v.optional(
      v.object({
        name: v.string(),
        fatherName: v.optional(v.string()),
        relationship: v.string(),
        // Required — the co-applicant's age is always derived from it.
        dob: v.number(),
        age: v.optional(v.number()), // compatibility only, never trusted
        gender: v.optional(v.string()),
        mobile: v.optional(v.string()),
        address: v.optional(v.string()),
        aadhaarNumber: v.optional(v.string()),
        panNumber: v.optional(v.string()),
        voterId: v.optional(v.string()),
        kycDocuments: v.optional(v.array(v.string())),
        photoStorageId: v.optional(v.id("_storage")),
        // Supporting KYC files for the co-applicant (Aadhaar/PAN/Voter/Other),
        // uploaded to private storage before this mutation runs and validated
        // against storage metadata inside the handler.
        documents: v.optional(
          v.array(
            v.object({
              docKind: v.string(),
              fileName: v.string(),
              storageId: v.id("_storage"),
            }),
          ),
        ),
        // Co-applicant GPS-tagged photograph: the stamped JPEG plus the
        // device-reported GPS fix. The file is uploaded before this mutation
        // runs and re-validaoted server-side (type + size + geo constraints).
        coGpsStorageId: v.optional(v.id("_storage")),
        coGpsGeo: v.optional(
          v.object({
            latitude: v.number(),
            longitude: v.number(),
            accuracyMeters: v.number(),
            capturedAt: v.number(), // GPS fix timestamp
            photoCapturedAt: v.optional(v.number()), // photo frame timestamp
            permissionStatus: v.optional(v.string()),
          }),
        ),
      }),
    ),
    // Informational loan request — never creates a loan, approval or
    // financial transaction. Disbursement stays in the authorized workflow.
    loanRequest: v.optional(
      v.object({
        amountRequested: v.number(),
        purpose: v.string(),
        tenureMonths: v.number(),
        repaymentFrequency: v.string(),
        estimatedInstallment: v.optional(v.number()),
      }),
    ),
    bankAccount: v.optional(
      v.object({
        accountHolderName: v.string(),
        bankName: v.string(),
        branch: v.string(),
        accountNumber: v.string(),
        ifscCode: v.string(),
      }),
    ),
    nominee: v.optional(
      v.object({
        name: v.string(),
        relationship: v.string(),
        age: v.number(),
        mobile: v.optional(v.string()),
        address: v.optional(v.string()),
      }),
    ),
    // Two character references given on the joining form — name + 10-digit
    // mobile each, at most two rows; blank rows are dropped server-side.
    references: v.optional(
      v.array(
        v.object({
          name: v.string(),
          mobile: v.string(),
        }),
      ),
    ),
    declarationAccepted: v.optional(v.boolean()),
    // FOR OFFICE USE ONLY — honored only for authorized roles (see handler).
    officeUse: v.optional(
      v.object({
        fieldOfficerName: v.optional(v.string()),
        customerVerification: v.optional(v.string()),
        kycVerification: v.optional(v.string()),
        creditAssessment: v.optional(v.string()),
        approvedLoanAmount: v.optional(v.number()),
        remarks: v.optional(v.string()),
      }),
    ),
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
    // server-issued upload URL before this mutation runs). Optional for the
    // new application form (which has no stamp field) but validated whenever
    // provided.
    stampStorageId: v.optional(v.id("_storage")),
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

    const now = Date.now();
    const name = requiredString(args.name, "name", 80);
    const mobile = mobileNumber(args.mobile);
    const gender = oneOf(args.gender, ["MALE", "FEMALE", "OTHER"], "gender");

    // The date of birth is mandatory and the ONLY source of age — a direct
    // backend call can never smuggle in an age inconsistent with it (the
    // client-submitted `age` field is accepted for compatibility, ignored).
    if (
      !Number.isFinite(args.dob) ||
      args.dob > now ||
      args.dob < now - 100 * 366 * 24 * 3_600_000
    ) {
      throw new AppError("Invalid date of birth.");
    }
    const dob = args.dob;
    const age = intInRange(ageFromDob(dob, now), "age", 18, 100);

    // Permanent address is mandatory for a new application. The legacy
    // `village` column (search + display) is derived from its first line
    // when the form does not collect one explicitly — legacy rows and all
    // downstream display logic keep working unchanged.
    const address = optionalString(args.address, "address", 300);
    const village =
      optionalString(args.village, "village", 80) ??
      address?.split(/[,\n]/)[0]?.trim().slice(0, 80) ??
      "";
    if (!village) {
      throw new AppError("Permanent address is required.");
    }
    const occupation = requiredString(args.occupation, "occupation", 80);

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
    const panNumber = optionalString(args.panNumber, "panNumber", 10)?.toUpperCase();
    if (panNumber && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(panNumber)) {
      throw new AppError("PAN number must look like ABCDE1234F.");
    }
    const voterId = optionalString(args.voterId, "voterId", 20)?.toUpperCase();
    if (voterId && !/^[A-Z]{3}[0-9]{7}$/.test(voterId)) {
      throw new AppError("Voter ID must look like ABC1234567.");
    }
    const kycDocuments = (args.kycDocuments ?? [])
      .slice(0, 4)
      .map((d) => oneOf(d, ["AADHAAR", "PAN", "VOTER_ID", "OTHER"], "kycDocuments"));
    const monthlyIncome = money(args.monthlyIncome, "monthlyIncome", { allowZero: true });
    const householdIncome = money(args.householdIncome, "householdIncome", { allowZero: true });
    const otherIncome =
      args.otherIncome !== undefined
        ? money(args.otherIncome, "otherIncome", { allowZero: true })
        : undefined;
    const existingLoanEmi =
      args.existingLoanEmi !== undefined
        ? money(args.existingLoanEmi, "existingLoanEmi", { allowZero: true })
        : undefined;
    const householdExpenses =
      args.householdExpenses !== undefined
        ? money(args.householdExpenses, "householdExpenses", { allowZero: true })
        : undefined;
    const typeOfBusiness =
      optionalString(args.typeOfBusiness, "typeOfBusiness", 120) ?? occupation;
    const businessAddress = optionalString(args.businessAddress, "businessAddress", 300);

    // Family details — structured rows from the application table. Fully
    // empty rows are ignored; at least one complete row is required by the
    // existing "family members ≥ 1" business rule.
    const familyRows = (args.familyRows ?? [])
      .slice(0, 20)
      .map((r) => ({
        name: requiredString(r.name, "family member name", 80),
        age:
          r.age !== undefined
            ? intInRange(r.age, "family member age", 1, 100)
            : undefined,
        relationship: requiredString(r.relationship, "family member relationship", 40),
        occupation: optionalString(r.occupation, "family member occupation", 120),
      }));
    if (familyRows.length === 0) {
      throw new AppError("Add at least one family member to the application.");
    }

    // Optional co-applicant — every provided value is validated; nothing is
    // auto-filled and the whole block is dropped when absent.
    let coApplicant: Doc<"clients">["coApplicant"];
    if (args.coApplicant) {
      const co = args.coApplicant;
      const coAadhaar = optionalString(co.aadhaarNumber, "coApplicant.aadhaarNumber", 12);
      if (coAadhaar && !/^\d{12}$/.test(coAadhaar)) {
        throw new AppError("Co-applicant Aadhaar must be exactly 12 digits.");
      }
      const coPan = optionalString(co.panNumber, "coApplicant.panNumber", 10)?.toUpperCase();
      if (coPan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(coPan)) {
        throw new AppError("Co-applicant PAN number must look like ABCDE1234F.");
      }
      const coVoter = optionalString(co.voterId, "coApplicant.voterId", 20)?.toUpperCase();
      if (coVoter && !/^[A-Z]{3}[0-9]{7}$/.test(coVoter)) {
        throw new AppError("Co-applicant Voter ID must look like ABC1234567.");
      }
      // The co-applicant's date of birth is required too — their age is
      // always derived from it, never taken from the client payload.
      if (
        !Number.isFinite(co.dob) ||
        co.dob > now ||
        co.dob < now - 100 * 366 * 24 * 3_600_000
      ) {
        throw new AppError("Invalid co-applicant date of birth.");
      }
      const coDob = co.dob;
      const coAge = intInRange(ageFromDob(coDob, now), "coApplicant.age", 18, 100);
      coApplicant = {
        name: requiredString(co.name, "coApplicant.name", 80),
        fatherName: optionalString(co.fatherName, "coApplicant.fatherName", 80),
        relationship: requiredString(co.relationship, "coApplicant.relationship", 40),
        dob: coDob,
        age: coAge,
        gender: co.gender
          ? oneOf(co.gender, ["MALE", "FEMALE", "OTHER"], "coApplicant.gender")
          : undefined,
        mobile: co.mobile ? mobileNumber(co.mobile, "coApplicant.mobile") : undefined,
        address: optionalString(co.address, "coApplicant.address", 300),
        aadhaarNumber: coAadhaar,
        panNumber: coPan,
        voterId: coVoter,
        kycDocuments: co.kycDocuments
          ?.slice(0, 4)
          .map((d) => oneOf(d, ["AADHAAR", "PAN", "VOTER_ID", "OTHER"], "coApplicant.kycDocuments")),
        // The geo camera stores the stamped file under coGpsStorageId;
        // it is surfaced here too so the co-applicant card can show it.
        photoStorageId: co.photoStorageId ?? co.coGpsStorageId,
      };
    }

    // Loan request — recorded on the application only. No loan, approval or
    // journal entry is created here; that stays in the loan workflow.
    const loanRequest: Doc<"clients">["loanRequest"] = args.loanRequest
      ? loanRequestValue(args.loanRequest)
      : undefined;

    const bankAccount: Doc<"clients">["bankAccount"] = args.bankAccount
      ? bankAccountValue(args.bankAccount)
      : undefined;

    const nominee: Doc<"clients">["nominee"] = args.nominee
      ? nomineeValue(args.nominee)
      : undefined;

    // Character references — blank rows are dropped by the parser, so an
    // untouched pair of rows leaves the field unset on the record.
    const references = referencesValue(args.references);

    // The declaration must be accepted; the timestamp stored is the
    // server's receipt time — tamper-proof.
    if (!args.declarationAccepted) {
      throw new AppError(
        "The declaration must be accepted before the application can be submitted.",
      );
    }

    // FOR OFFICE USE ONLY: honored only when the creator is an authorized
    // role — a field officer's submission can never mark a client verified,
    // recommended or approved.
    let officeUse: Doc<"clients">["officeUse"];
    if (
      args.officeUse &&
      (me.role === "SUPER_ADMIN" || me.role === "BRANCH_MANAGER")
    ) {
      const o = args.officeUse;
      officeUse = {
        fieldOfficerName: optionalString(o.fieldOfficerName, "officeUse.fieldOfficerName", 80),
        customerVerification:
          o.customerVerification !== undefined
            ? oneOf(o.customerVerification, OFFICE_VERIFICATION, "officeUse.customerVerification")
            : undefined,
        kycVerification:
          o.kycVerification !== undefined
            ? oneOf(o.kycVerification, OFFICE_KYC, "officeUse.kycVerification")
            : undefined,
        creditAssessment:
          o.creditAssessment !== undefined
            ? oneOf(o.creditAssessment, OFFICE_CREDIT, "officeUse.creditAssessment")
            : undefined,
        approvedLoanAmount:
          o.approvedLoanAmount !== undefined
            ? money(o.approvedLoanAmount, "officeUse.approvedLoanAmount", { allowZero: true })
            : undefined,
        remarks: optionalString(o.remarks, "officeUse.remarks", 500),
        updatedAt: now,
        updatedBy: me._id,
      };
    }

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

    const assignee = args.assignedTo ?? me._id;
    const assigneeProfile = await ctx.db.get(assignee);
    if (!assigneeProfile) throw new AppError("Assignee not found.");
    if (assigneeProfile.role === "CLIENT") {
      throw new AppError("A client profile cannot own a client assignment.");
    }
    // Server-side branch rule: except for the org-wide SUPER_ADMIN, the
    // assignee must belong to the caller's own branch. A frontend-supplied
    // `assignedTo` can therefore never push a client into another branch
    // (which would hide it from the correct Branch Manager).
    if (
      me.role !== "SUPER_ADMIN" &&
      assigneeProfile.branchId &&
      branchId &&
      assigneeProfile.branchId !== branchId
    ) {
      throw new AppError(
        "You can only onboard clients for staff in your own branch.",
      );
    }
    branchId = assigneeProfile.branchId ?? branchId;

    // Client numbers come from their OWN sequence (separate from staff):
    // numeric only — no role prefix, no hyphen — leading zeros kept
    // (000001, 000002, ...). Legacy "C-000137" style codes still count
    // towards the highest number, so a restored database never reissues a
    // number. The counter row makes duplicate client IDs impossible even
    // under concurrent creation (Convex serialises mutation commits).
    const existing = await ctx.db.query("clients").collect();
    const clientCounter = await ctx.db
      .query("counters")
      .withIndex("by_key", (q) => q.eq("key", "client"))
      .unique();
    let highestClientNumber = clientCounter?.value ?? 0;
    for (const c of existing) {
      const n = Number(c.code.replace(/\D/g, "") || 0);
      if (n > highestClientNumber) highestClientNumber = n;
    }
    const nextClientNumber = highestClientNumber + 1;
    if (clientCounter) {
      if (clientCounter.value !== nextClientNumber) {
        await ctx.db.patch(clientCounter._id, { value: nextClientNumber });
      }
    } else {
      await ctx.db.insert("counters", { key: "client", value: nextClientNumber });
    }
    const code = String(nextClientNumber).padStart(6, "0");

    // Centre linkage: the centre selected in the joining form is re-verified
    // against the database here (exists + same branch) so a direct backend
    // call cannot attach a client to an unknown or foreign centre. The
    // centre's permanent generated ID (e.g. BALLIA-001) is stored on the
    // client — clients never generate their own centre IDs.
    const resolvedCenter = await resolveCenterForClient(
      ctx,
      branchId,
      optionalString(args.centerCode, "centerCode", 40),
    );

    const clientId = await ctx.db.insert("clients", {
      code,
      name,
      fatherName: optionalString(args.fatherName, "fatherName", 80),
      applicantFatherName: optionalString(args.applicantFatherName, "applicantFatherName", 80),
      husbandName: optionalString(args.husbandName, "husbandName", 80),
      fatherAddress: optionalString(args.fatherAddress, "fatherAddress", 300),
      maternalHomeAddress: optionalString(args.maternalHomeAddress, "maternalHomeAddress", 300),
      dob,
      age,
      gender,
      mobile,
      altMobile: args.altMobile ? mobileNumber(args.altMobile, "altMobile") : undefined,
      address,
      village,
      district: optionalString(args.district, "district", 80) ?? "—",
      state: optionalString(args.state, "state", 80) ?? "Uttar Pradesh",
      pin: optionalString(args.pin, "pin", 8) ?? "000000",
      occupation,
      typeOfBusiness,
      businessAddress,
      monthlyIncome,
      householdIncome: householdIncome || monthlyIncome,
      householdExpenses,
      otherIncome,
      existingLoanEmi,
      familyMembers: familyRows.length,
      coApplicant,
      loanRequest,
      bankAccount,
      nominee,
      references,
      declarationAcceptedAt: now,
      officeUse,
      panNumber,
      voterId,
      kycDocuments: kycDocuments.length > 0 ? kycDocuments : undefined,
      branchId,
      assignedTo: assignee,
      createdBy: me._id,
      kycStatus: "PENDING",
      kycDocType,
      kycDocRef,
      centerCode: resolvedCenter.centerCode,
      centerId: resolvedCenter.centerId,
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

    // Structured family rows — one record per member, linked to the client.
    for (const row of familyRows) {
      await ctx.db.insert("clientFamilyMembers", {
        clientId,
        name: row.name,
        age: row.age,
        relationship: row.relationship,
        occupation: row.occupation,
        createdAt: now,
      });
    }

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

    // ---- Optional stamp document (validated whenever provided) -----------
    const MAX_STAMP_BYTES = 5 * 1024 * 1024;
    if (args.stampStorageId) {
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

    let stampFileName: string | undefined;
    if (args.stampStorageId) {
      const stampMeta = await ctx.db.system.get("_storage", args.stampStorageId);
      stampFileName = `client-stamp-${code}.${
        stampMeta?.contentType === "application/pdf" ? "pdf" : "jpg"
      }`;
      await ctx.db.insert("clientDocuments", {
        clientId,
        type: "STAMP",
        fileName: stampFileName,
        status: "UPLOADED",
        uploadedBy: me._id,
        storageId: args.stampStorageId,
        sizeBytes: stampMeta?.size ?? 0,
        mimeType: stampMeta?.contentType,
        createdAt: now,
      });
    }

    // ---- Applicant KYC documents (normal captures — no geo-tagging) ------
    // Uploaded to private storage before this mutation ran and re-validated
    // from storage metadata here. These rows carry NO coApplicant flag, so
    // they stay attached to the applicant side of this application only.
    const applicantDocArgs = (args.documents ?? []).slice(0, 12);
    let applicantDocCount = 0;
    if (applicantDocArgs.length > 0) {
      const validatedApplicantDocs = await validateUploadedKycDocs(
        ctx,
        applicantDocArgs,
        "Applicant document",
      );
      for (const d of validatedApplicantDocs) {
        await ctx.db.insert("clientDocuments", {
          clientId,
          type: "KYC",
          fileName: d.fileName,
          status: "UPLOADED",
          uploadedBy: me._id,
          storageId: d.storageId,
          sizeBytes: d.sizeBytes,
          mimeType: d.mimeType,
          docKind: d.docKind,
          createdAt: now,
        });
      }
      applicantDocCount = validatedApplicantDocs.length;
    }

    // ---- Co-applicant photo — geo-tagged via the existing geo camera -----
    // The stamped JPEG travels with the fix it was stamped with
    // (coGpsStorageId + coGpsGeo) and the two must arrive together, so a
    // photo can never be stored as geo-tagged without coordinates the server
    // has validated with the SAME rules as the applicant's photo. The legacy
    // plain photoStorageId path (no geo) still works for older callers.
    const coGpsId = args.coApplicant?.coGpsStorageId ?? null;
    const coGpsGeo = args.coApplicant?.coGpsGeo ?? null;
    if ((coGpsId && !coGpsGeo) || (!coGpsId && coGpsGeo)) {
      if (coGpsId) await ctx.storage.delete(coGpsId);
      throw new AppError(
        "Co-applicant photo location is missing — capture it again with GPS on.",
      );
    }
    const coPhotoId = coGpsId ?? args.coApplicant?.photoStorageId ?? null;
    if (coPhotoId) {
      if (coGpsGeo) {
        const coFix: GeoFix = {
          latitude: coGpsGeo.latitude,
          longitude: coGpsGeo.longitude,
          accuracyMeters: coGpsGeo.accuracyMeters,
          capturedAt: coGpsGeo.capturedAt,
          permissionStatus: coGpsGeo.permissionStatus ?? "granted",
        };
        const coGeoError = geoValidationError(coFix, now);
        if (coGeoError) {
          await ctx.storage.delete(coPhotoId);
          throw new AppError(
            `Co-applicant photo location rejected: ${coGeoError}`,
          );
        }
      }

      const coMeta = await ctx.db.system.get("_storage", coPhotoId);
      const coTypes = ["image/jpeg", "image/png", "image/webp"];
      if (
        !coMeta ||
        !coMeta.contentType ||
        !coTypes.includes(coMeta.contentType) ||
        coMeta.size <= 0 ||
        coMeta.size > MAX_CLIENT_PHOTO_BYTES
      ) {
        if (coMeta) await ctx.storage.delete(coPhotoId);
        throw new AppError(
          "Co-applicant photo must be a JPEG, PNG or WebP image under 5 MB — capture it again.",
        );
      }

      const coFileName = `co-applicant-photo-${code}.jpg`;
      if (coGpsGeo) {
        // Geo capture row — flagged so `clients.geoPhoto` keeps surfacing
        // the APPLICANT's photo while this one lives on the co-applicant
        // card (same file, same access checks as the rest of this mutation).
        await ctx.db.insert("clientGeoPhotos", {
          clientId,
          storageId: coPhotoId,
          fileName: coFileName,
          sizeBytes: coMeta.size,
          mimeType: coMeta.contentType,
          latitude: coGpsGeo.latitude,
          longitude: coGpsGeo.longitude,
          accuracyMeters: Math.round(coGpsGeo.accuracyMeters * 100) / 100,
          capturedAt: coGpsGeo.capturedAt,
          photoCapturedAt: coGpsGeo.photoCapturedAt ?? coGpsGeo.capturedAt,
          uploadedAt: now,
          uploadedBy: me._id,
          branchId,
          permissionStatus: coGpsGeo.permissionStatus ?? "granted",
          device: args.device,
          status: "GEO_TAGGED",
          coApplicant: true,
        });
      }

      await ctx.db.insert("clientDocuments", {
        clientId,
        type: "OTHER",
        fileName: coFileName,
        status: "UPLOADED",
        uploadedBy: me._id,
        storageId: coPhotoId,
        sizeBytes: coMeta.size,
        mimeType: coMeta.contentType,
        coApplicant: true,
        createdAt: now,
      });
    }

    // ---- Co-applicant documents (normal captures — no geo-tagging) -------
    // Same validation as the applicant's documents, inserted with the
    // coApplicant flag so they stay attached to the co-applicant block of
    // this application only.
    const coDocArgs = (args.coApplicant?.documents ?? []).slice(0, 8);
    let coDocCount = 0;
    if (coDocArgs.length > 0) {
      const validatedCoDocs = await validateUploadedKycDocs(
        ctx,
        coDocArgs,
        "Co-applicant document",
      );
      for (const d of validatedCoDocs) {
        await ctx.db.insert("clientDocuments", {
          clientId,
          type: "KYC",
          fileName: d.fileName,
          status: "UPLOADED",
          uploadedBy: me._id,
          storageId: d.storageId,
          sizeBytes: d.sizeBytes,
          mimeType: d.mimeType,
          coApplicant: true,
          docKind: d.docKind,
          createdAt: now,
        });
      }
      coDocCount = validatedCoDocs.length;
    }

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
        familyMembers: familyRows.length,
        hasCoApplicant: Boolean(coApplicant),
        applicantDocs: applicantDocCount,
        coApplicantDocs: coDocCount,
        hasLoanRequest: Boolean(loanRequest),
        hasBankAccount: Boolean(bankAccount),
        hasNominee: Boolean(nominee),
        declarationAcceptedAt: now,
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

    // Latest APPLICANT geo photo — co-applicant captures are stored with
    // `coApplicant: true` and shown on the co-applicant card instead, so
    // they can never replace the applicant's photo here.
    const rows = await ctx.db
      .query("clientGeoPhotos")
      .withIndex("by_client", (q) => q.eq("clientId", clientId))
      .order("desc")
      .collect();
    const photo = rows.find((r) => !r.coApplicant) ?? null;
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
    applicantFatherName: v.optional(v.string()),
    maternalHomeAddress: v.optional(v.string()),
    mobile: v.optional(v.string()),
    altMobile: v.optional(v.string()),
    address: v.optional(v.string()),
    village: v.optional(v.string()),
    occupation: v.optional(v.string()),
    monthlyIncome: v.optional(v.number()),
    householdIncome: v.optional(v.number()),
    familyMembers: v.optional(v.number()),
    // Application sections from the joining form — income & business, loan
    // request, bank account, nominee and references. Each object REPLACES the
    // stored block, `null` clears it, and an omitted field is never touched
    // (so an edit of one section can never wipe another).
    typeOfBusiness: v.optional(v.string()),
    businessAddress: v.optional(v.string()),
    otherIncome: v.optional(v.union(v.number(), v.null())),
    householdExpenses: v.optional(v.union(v.number(), v.null())),
    existingLoanEmi: v.optional(v.union(v.number(), v.null())),
    loanRequest: v.optional(
      v.union(
        v.object({
          amountRequested: v.number(),
          purpose: v.string(),
          tenureMonths: v.number(),
          repaymentFrequency: v.string(),
          estimatedInstallment: v.optional(v.number()),
        }),
        v.null(),
      ),
    ),
    bankAccount: v.optional(
      v.union(
        v.object({
          accountHolderName: v.string(),
          bankName: v.string(),
          branch: v.string(),
          accountNumber: v.string(),
          ifscCode: v.string(),
        }),
        v.null(),
      ),
    ),
    nominee: v.optional(
      v.union(
        v.object({
          name: v.string(),
          relationship: v.string(),
          age: v.number(),
          mobile: v.optional(v.string()),
          address: v.optional(v.string()),
        }),
        v.null(),
      ),
    ),
    references: v.optional(
      v.union(
        v.array(
          v.object({
            name: v.string(),
            mobile: v.string(),
          }),
        ),
        v.null(),
      ),
    ),
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
    if (args.applicantFatherName !== undefined)
      patch.applicantFatherName = optionalString(
        args.applicantFatherName,
        "applicantFatherName",
        80,
      );
    if (args.maternalHomeAddress !== undefined)
      patch.maternalHomeAddress = optionalString(args.maternalHomeAddress, "maternalHomeAddress", 300);
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
    // Application sections — the SAME validators create uses, so an edit can
    // never store what the joining form itself would reject.
    if (args.typeOfBusiness !== undefined)
      patch.typeOfBusiness = optionalString(args.typeOfBusiness, "typeOfBusiness", 120);
    if (args.businessAddress !== undefined)
      patch.businessAddress = optionalString(args.businessAddress, "businessAddress", 300);
    if (args.otherIncome !== undefined)
      patch.otherIncome =
        args.otherIncome === null
          ? undefined
          : money(args.otherIncome, "otherIncome", { allowZero: true });
    if (args.householdExpenses !== undefined)
      patch.householdExpenses =
        args.householdExpenses === null
          ? undefined
          : money(args.householdExpenses, "householdExpenses", { allowZero: true });
    if (args.existingLoanEmi !== undefined)
      patch.existingLoanEmi =
        args.existingLoanEmi === null
          ? undefined
          : money(args.existingLoanEmi, "existingLoanEmi", { allowZero: true });
    if (args.loanRequest !== undefined)
      patch.loanRequest =
        args.loanRequest === null ? undefined : loanRequestValue(args.loanRequest);
    if (args.bankAccount !== undefined)
      patch.bankAccount =
        args.bankAccount === null ? undefined : bankAccountValue(args.bankAccount);
    if (args.nominee !== undefined)
      patch.nominee = args.nominee === null ? undefined : nomineeValue(args.nominee);
    if (args.references !== undefined)
      patch.references =
        args.references === null ? undefined : referencesValue(args.references);
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

/**
 * FOR OFFICE USE ONLY — verification, credit assessment, approved amount and
 * branch-manager remarks. Authorized roles only (SUPER_ADMIN / BRANCH_MANAGER);
 * every change is audit-logged with the actor's name. Never called
 * automatically: a client is never marked verified/approved by submission.
 */
export const updateOfficeUse = mutation({
  args: {
    clientId: v.id("clients"),
    fieldOfficerName: v.optional(v.string()),
    customerVerification: v.optional(v.string()),
    kycVerification: v.optional(v.string()),
    creditAssessment: v.optional(v.string()),
    approvedLoanAmount: v.optional(v.number()),
    remarks: v.optional(v.string()),
    device: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx);
    requireRole(me, "SUPER_ADMIN", "BRANCH_MANAGER");
    const client = await ctx.db.get(args.clientId);
    if (!client) throw new AppError("Client not found.");
    const prev = client.officeUse;

    const next: NonNullable<Doc<"clients">["officeUse"]> = {
      fieldOfficerName:
        args.fieldOfficerName !== undefined
          ? optionalString(args.fieldOfficerName, "fieldOfficerName", 80)
          : prev?.fieldOfficerName,
      customerVerification:
        args.customerVerification !== undefined
          ? oneOf(args.customerVerification, OFFICE_VERIFICATION, "customerVerification")
          : prev?.customerVerification,
      kycVerification:
        args.kycVerification !== undefined
          ? oneOf(args.kycVerification, OFFICE_KYC, "kycVerification")
          : prev?.kycVerification,
      creditAssessment:
        args.creditAssessment !== undefined
          ? oneOf(args.creditAssessment, OFFICE_CREDIT, "creditAssessment")
          : prev?.creditAssessment,
      approvedLoanAmount:
        args.approvedLoanAmount !== undefined
          ? money(args.approvedLoanAmount, "approvedLoanAmount", { allowZero: true })
          : prev?.approvedLoanAmount,
      remarks:
        args.remarks !== undefined
          ? optionalString(args.remarks, "remarks", 500)
          : prev?.remarks,
      updatedAt: Date.now(),
      updatedBy: me._id,
    };

    await ctx.db.patch(args.clientId, { officeUse: next });
    await logAudit(ctx, {
      actorId: me._id,
      actorName: me.name,
      role: me.role,
      action: "CLIENT_OFFICE_USE_UPDATED",
      entity: "clients",
      entityId: client.code,
      before: { officeUse: prev ?? null },
      after: { officeUse: next },
      referenceId: client.code,
      branchId: client.branchId,
      device: args.device,
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

/* ---------------------------- Centre creation ---------------------------- */

/**
 * Create a centre from the New Client popup ("+ Create New Center").
 * Generates the unique Centre ID (e.g. BALLIA-001) ONCE, saves it on the
 * centre record permanently, and returns it so the joining form can
 * preselect the new centre immediately.
 */
export const createCenter = mutation({
  args: {
    name: v.string(),
    village: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx);
    requirePermission(me, "create_client");
    const center = await createCenterForActor(ctx, me, args);
    return { center };
  },
});

/** Lightweight centre picker for the New Client popup (ID or name search). */
export const centerSearch = query({
  args: { q: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    requirePermission(me, "create_client");
    const q = (args.q ?? "").trim().toLowerCase();
    const centers = (await ctx.db.query("centers").collect())
      .filter(
        (c) =>
          me.role === "SUPER_ADMIN" || !me.branchId || c.branchId === me.branchId,
      )
      .filter(
        (c) =>
          !q || c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    return centers.map((c) => ({
      _id: c._id,
      code: c.code,
      name: c.name,
      village: c.village,
    }));
  },
});

/**
 * Centre-wise client report: fetch all registered clients linked to a
 * Centre ID (e.g. BALLIA-001) from the database. Access is enforced on
 * the backend — the viewer's client scope is applied first, then the
 * centre's branch access is checked, so clients of another centre (or
 * outside the viewer's scope) can never appear.
 */
export const centerReport = query({
  args: {
    centerCode: v.string(),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const me = await requireProfile(ctx, { allowInactive: true });
    requirePermission(me, "view_clients");

    const centers = await ctx.db.query("centers").collect();
    const visible = await visibleClients(ctx, me);
    const base = centerReportRows(me, centers, visible, args);

    const profiles = await ctx.db.query("profiles").collect();
    const staffById = new Map(profiles.map((p) => [p._id, p]));

    return {
      status: base.status,
      center: base.center,
      total: base.total,
      limit: Math.min(Math.max(Math.floor(args.limit ?? 25), 1), 100),
      offset: Math.max(Math.floor(args.offset ?? 0), 0),
      clients: base.clients.map((c) => ({
        _id: c._id,
        code: c.code,
        name: c.name,
        mobile: c.mobile,
        village: c.village,
        kycStatus: c.kycStatus,
        status: c.status,
        createdAt: c.createdAt,
        centerCode: c.centerCode ?? base.center?.code ?? null,
        staffName: staffById.get(c.assignedTo)?.name ?? "—",
      })),
    };
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
