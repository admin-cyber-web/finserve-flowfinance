import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);
export type Role = Infer<typeof roleValidator>;

/**
 * FinServe schema.
 *
 * Financial truth is ONLY ever derived from append-only ledgers
 * (walletTransactions, collections, journalEntries). Balances are computed
 * server-side from those tables — there is no editable balance field and no
 * delete path for a financial transaction.
 *
 * Enum-ish fields are stored as strings and validated against the domain
 * vocabularies in src/lib/finance/types.ts by the mutation layer.
 */
const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    // the users table is the default users table that is brought in by the authTables
    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // email of the user. do not remove
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is the user anonymous. do not remove

      role: v.optional(roleValidator), // role of the user. do not remove
    }).index("email", ["email"]), // index for the email. do not remove or modify

    /* ----------------------------- Organisation ---------------------------- */

    branches: defineTable({
      code: v.string(),
      name: v.string(),
      city: v.string(),
      state: v.string(),
      status: v.string(), // ACTIVE | INACTIVE
      createdAt: v.number(),
    }),

    // A profile is the FinServe workspace identity of a user (staff, BM,
    // admin, accountant or a client portal login).
    profiles: defineTable({
      userId: v.optional(v.id("users")),
      email: v.optional(v.string()),
      mobile: v.optional(v.string()),
      name: v.string(),
      staffId: v.string(), // ST10025 / BM-20004 / C-000128
      role: v.string(), // SUPER_ADMIN | BRANCH_MANAGER | FIELD_STAFF | ACCOUNTANT | CLIENT
      branchId: v.optional(v.id("branches")),
      status: v.string(), // ACTIVE | SUSPENDED | BLOCKED | DEACTIVATED
      persona: v.optional(v.string()), // legacy demo-seed tag (inert: no auth path reads it)
      clientId: v.optional(v.id("clients")), // set for CLIENT role
      image: v.optional(v.string()),
      joiningDate: v.optional(v.number()),
      permissions: v.optional(v.array(v.string())), // per-user permission override
      twoFactorEnabled: v.optional(v.boolean()),
      createdBy: v.optional(v.id("profiles")),
      createdAt: v.number(),
      credentialHash: v.optional(v.string()),
      mustChangePassword: v.optional(v.boolean()),
      lastLoginAt: v.optional(v.number()),
      failedLoginAttempts: v.optional(v.number()),
      lockedUntil: v.optional(v.number()),
    })
      .index("by_user", ["userId"])
      .index("by_email", ["email"])
      .index("by_branch", ["branchId"])
      .index("by_role", ["role"])
      .index("by_persona", ["persona"])
      .index("by_staffId", ["staffId"]),

    /* ------------------------------- Wallet -------------------------------- */

    // Only the APPROVED LIMIT lives here. The available balance is always
    // derived from walletTransactions — never stored, never edited.
    wallets: defineTable({
      profileId: v.id("profiles"),
      branchId: v.id("branches"),
      walletLimit: v.number(),
      status: v.string(), // ACTIVE | SUSPENDED
      createdAt: v.number(),
    }).index("by_profile", ["profileId"]),

    walletTransactions: defineTable({
      txnId: v.string(), // WT-000001
      walletId: v.id("wallets"),
      profileId: v.id("profiles"),
      branchId: v.id("branches"),
      type: v.string(), // WALLET_TX_TYPES
      amount: v.number(),
      direction: v.string(), // CREDIT | DEBIT | NONE
      balanceBefore: v.number(), // server-derived snapshot at write time
      balanceAfter: v.number(),
      referenceType: v.optional(v.string()), // LOAN | COLLECTION | HANDOVER | ISSUE | EXPENSE | ADJUSTMENT
      referenceId: v.optional(v.string()),
      idempotencyKey: v.optional(v.string()),
      createdBy: v.optional(v.id("profiles")),
      approvedBy: v.optional(v.id("profiles")),
      remarks: v.optional(v.string()),
      reversalOfId: v.optional(v.id("walletTransactions")),
      createdAt: v.number(),
    })
      .index("by_wallet", ["walletId", "createdAt"])
      .index("by_idem", ["idempotencyKey"])
      .index("by_ref", ["referenceId"])
      .index("by_profile", ["profileId", "createdAt"])
      .index("by_created", ["createdAt"]),

    /* -------------------------------- Clients ------------------------------ */

    clients: defineTable({
      code: v.string(), // C-000128
      name: v.string(),
      fatherName: v.optional(v.string()),
      // Applicant's own father name — kept separate from the legacy
      // `fatherName` column, which stores the husband's name.
      applicantFatherName: v.optional(v.string()),
      maternalHomeAddress: v.optional(v.string()),
      dob: v.optional(v.number()),
      age: v.number(),
      gender: v.string(), // MALE | FEMALE | OTHER
      mobile: v.string(),
      altMobile: v.optional(v.string()),
      address: v.optional(v.string()), // permanent address (full text)
      fatherAddress: v.optional(v.string()),
      husbandName: v.optional(v.string()),
      panNumber: v.optional(v.string()),
      voterId: v.optional(v.string()),
      kycDocuments: v.optional(v.array(v.string())), // AADHAAR | PAN | VOTER_ID | OTHER
      village: v.string(),
      district: v.string(),
      state: v.string(),
      pin: v.string(),
      occupation: v.string(),
      monthlyIncome: v.number(),
      householdIncome: v.number(),
      familyMembers: v.number(), // count — rows live in clientFamilyMembers
      typeOfBusiness: v.optional(v.string()),
      businessAddress: v.optional(v.string()),
      otherIncome: v.optional(v.number()),
      householdExpenses: v.optional(v.number()),
      existingLoanEmi: v.optional(v.number()),
      // Optional co-applicant — validated when present, never auto-filled.
      coApplicant: v.optional(
        v.object({
          name: v.string(),
          fatherName: v.optional(v.string()),
          relationship: v.string(),
          dob: v.optional(v.number()),
          age: v.optional(v.number()),
          gender: v.optional(v.string()),
          mobile: v.optional(v.string()),
          address: v.optional(v.string()),
          aadhaarNumber: v.optional(v.string()),
          panNumber: v.optional(v.string()),
          voterId: v.optional(v.string()),
          kycDocuments: v.optional(v.array(v.string())),
          photoStorageId: v.optional(v.id("_storage")),
        }),
      ),
      // Loan request captured with the application — informational only.
      // It never creates a loan, approval or financial transaction.
      loanRequest: v.optional(
        v.object({
          amountRequested: v.number(),
          purpose: v.string(), // BUSINESS | AGRICULTURE | EDUCATION | MEDICAL | HOUSEHOLD | OTHER
          tenureMonths: v.number(),
          repaymentFrequency: v.string(), // WEEKLY | FORTNIGHTLY | MONTHLY
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
      // Two character references given on the joining form. Empty rows are
      // never stored — only complete name + mobile pairs survive validation.
      references: v.optional(
        v.array(
          v.object({
            name: v.string(),
            mobile: v.string(),
          }),
        ),
      ),
      declarationAcceptedAt: v.optional(v.number()),
      // FOR OFFICE USE ONLY — written only by authorized roles
      // (SUPER_ADMIN / BRANCH_MANAGER) via create (when authorized) or
      // clients.updateOfficeUse. Never auto-set to verified/approved.
      officeUse: v.optional(
        v.object({
          fieldOfficerName: v.optional(v.string()),
          customerVerification: v.optional(v.string()), // VERIFIED | NOT_VERIFIED
          kycVerification: v.optional(v.string()), // COMPLETE | INCOMPLETE
          creditAssessment: v.optional(v.string()), // RECOMMENDED | NOT_RECOMMENDED
          approvedLoanAmount: v.optional(v.number()),
          remarks: v.optional(v.string()),
          updatedAt: v.number(),
          updatedBy: v.optional(v.id("profiles")),
        }),
      ),
      branchId: v.id("branches"),
      assignedTo: v.id("profiles"),
      createdBy: v.id("profiles"),
      kycStatus: v.string(), // PENDING | VERIFIED | REJECTED
      kycDocType: v.optional(v.string()),
      kycDocRef: v.optional(v.string()),
      verifiedBy: v.optional(v.id("profiles")),
      verifiedAt: v.optional(v.number()),
      centerCode: v.optional(v.string()),
      // Permanent database reference to the centre (set once when the client
      // is linked; centerCode holds the generated ID e.g. BALLIA-001).
      centerId: v.optional(v.id("centers")),
      groupCode: v.optional(v.string()),
      status: v.string(), // ACTIVE | INACTIVE
      searchText: v.string(), // lowercased name/mobile/code for search
      createdAt: v.number(),
    })
      .index("by_code", ["code"])
      .index("by_mobile", ["mobile"])
      .index("by_branch", ["branchId"])
      .index("by_staff", ["assignedTo"])
      .index("by_created", ["createdAt"]),

    // Geo-tagged client photos: one immutable capture row per client photo.
    // The image itself lives in Convex file storage (private, signed URLs —
    // never a public bucket); coordinates are DEVICE-REPORTED at capture time.
    clientGeoPhotos: defineTable({
      clientId: v.id("clients"),
      storageId: v.id("_storage"),
      fileName: v.string(),
      sizeBytes: v.number(),
      mimeType: v.string(),
      latitude: v.number(),
      longitude: v.number(),
      accuracyMeters: v.number(),
      capturedAt: v.number(), // device-reported GPS FIX time
      photoCapturedAt: v.optional(v.number()), // photo frame time (kept separate)
      uploadedAt: v.number(), // server receipt time
      uploadedBy: v.id("profiles"),
      branchId: v.id("branches"),
      permissionStatus: v.optional(v.string()), // geolocation permission at capture
      device: v.optional(v.string()),
      status: v.string(), // GEO_TAGGED
      // Marks a co-applicant capture so the applicant's own geo photo stays
      // the one surfaced by `clients.geoPhoto` (the co-applicant photo is
      // shown in the co-applicant card on the client page).
      coApplicant: v.optional(v.boolean()),
    }).index("by_client", ["clientId"]),

    // Family members of an applicant, captured as structured rows on the
    // client application (S.No. / name / age / relationship / occupation).
    clientFamilyMembers: defineTable({
      clientId: v.id("clients"),
      name: v.string(),
      age: v.optional(v.number()),
      relationship: v.string(),
      occupation: v.optional(v.string()),
      createdAt: v.number(),
    }).index("by_client", ["clientId"]),

    clientStaffHistory: defineTable({
      clientId: v.id("clients"),
      fromStaffId: v.optional(v.id("profiles")),
      toStaffId: v.id("profiles"),
      reason: v.optional(v.string()),
      createdBy: v.id("profiles"),
      createdAt: v.number(),
    }).index("by_client", ["clientId", "createdAt"]),

    clientDocuments: defineTable({
      clientId: v.id("clients"),
      type: v.string(), // CLIENT_PHOTO | KYC | STAMP | ADDRESS_PROOF | OTHER
      fileName: v.string(),
      status: v.string(), // UPLOADED | PENDING_VERIFICATION | VERIFIED | REJECTED
      uploadedBy: v.id("profiles"),
      storageId: v.optional(v.id("_storage")), // private Convex storage ref
      sizeBytes: v.optional(v.number()), // upload metadata (validated at create)
      mimeType: v.optional(v.string()),
      // Co-applicant uploads: marks the row as belonging to the co-applicant
      // block and records which KYC kind it is (AADHAAR | PAN | VOTER_ID | OTHER).
      coApplicant: v.optional(v.boolean()),
      docKind: v.optional(v.string()),
      verifiedBy: v.optional(v.id("profiles")),
      note: v.optional(v.string()),
      createdAt: v.number(),
    }).index("by_client", ["clientId"]),

    clientNotes: defineTable({
      clientId: v.id("clients"),
      profileId: v.id("profiles"),
      body: v.string(),
      createdAt: v.number(),
    }).index("by_client", ["clientId", "createdAt"]),

    /* ----------------------------- Loan products --------------------------- */

    loanProducts: defineTable({
      code: v.string(), // PRC-WMC
      name: v.string(),
      minAmount: v.number(),
      maxAmount: v.number(),
      interestRate: v.number(), // annual % p.a.
      interestMethod: v.string(), // FLAT | REDUCING
      tenure: v.number(), // number of installments
      frequency: v.string(), // WEEKLY | FORTNIGHTLY | MONTHLY
      processingFee: v.number(), // flat ₹
      chargePercent: v.number(), // approved charges as % of principal
      graceDays: v.number(),
      maxObligationRatio: v.number(), // policy: max obligations % of income
      status: v.string(), // ACTIVE | INACTIVE
      createdAt: v.number(),
    }).index("by_code", ["code"]),

    loanApplications: defineTable({
      appId: v.string(), // LA-000123
      clientId: v.id("clients"),
      productId: v.id("loanProducts"),
      amount: v.number(),
      staffId: v.id("profiles"),
      branchId: v.id("branches"),
      // Centre the client belongs to — set when the application is created
      // (centre-wise disbursement traces every request back to its centre).
      centerId: v.optional(v.id("centers")),
      status: v.string(), // DRAFT | SUBMITTED | UNDER_REVIEW | APPROVED | REJECTED | DISBURSED
      history: v.array(
        v.object({
          actorId: v.optional(v.id("profiles")),
          actorName: v.string(),
          role: v.string(),
          action: v.string(),
          remark: v.optional(v.string()),
          at: v.number(),
        }),
      ),
      eligibility: v.optional(v.any()), // snapshot of the policy evaluation
      submittedAt: v.optional(v.number()),
      decidedAt: v.optional(v.number()),
      decisionReason: v.optional(v.string()),
      loanId: v.optional(v.id("loans")),
      createdAt: v.number(),
    })
      .index("by_status", ["status", "createdAt"])
      .index("by_staff", ["staffId", "createdAt"])
      .index("by_client", ["clientId"]),

    /* --------------------------------- Loans ------------------------------- */

    loans: defineTable({
      loanId: v.string(), // LN-000123
      applicationId: v.optional(v.id("loanApplications")),
      clientId: v.id("clients"),
      productId: v.id("loanProducts"),
      staffId: v.id("profiles"),
      branchId: v.id("branches"),
      // Centre the client belonged to at sanction — copied from the client
      // record on approval so every loan traces back to its centre.
      centerId: v.optional(v.id("centers")),
      principal: v.number(),
      interestTotal: v.number(),
      charges: v.number(),
      totalPayable: v.number(),
      installment: v.number(),
      frequency: v.string(),
      tenure: v.number(),
      interestRate: v.number(),
      interestMethod: v.string(),
      status: v.string(), // LOAN_STATUSES
      outstanding: v.number(),
      paidTotal: v.number(),
      disbursedAt: v.optional(v.number()),
      disbursedBy: v.optional(v.id("profiles")),
      approvedBy: v.optional(v.id("profiles")),
      approvedAt: v.optional(v.number()),
      closeDate: v.optional(v.number()),
      // SUPER_ADMIN closure lifecycle (surrender / settle / close / archive).
      // `closeDate` is the closure moment; `closureKind` is REPAYMENT |
      // SURRENDER | SETTLEMENT; `waivedAmount` is money written off by an
      // approved settlement — never counted as cash received. Archived loans
      // are hidden from ordinary loan screens but kept for audit.
      closedBy: v.optional(v.id("profiles")),
      closureKind: v.optional(v.string()),
      closureReason: v.optional(v.string()),
      waivedAmount: v.optional(v.number()),
      archivedAt: v.optional(v.number()),
      nextDueDate: v.optional(v.number()),
      lastPaymentAt: v.optional(v.number()),
      overdueDays: v.number(),
      createdAt: v.number(),
    })
      .index("by_loanId", ["loanId"])
      .index("by_client", ["clientId"])
      .index("by_staff", ["staffId"])
      .index("by_branch", ["branchId"])
      .index("by_status", ["status"]),

    loanSchedules: defineTable({
      loanId: v.id("loans"),
      index: v.number(),
      dueDate: v.number(),
      principal: v.number(),
      interest: v.number(),
      totalDue: v.number(),
      paid: v.number(),
      // Amounts written off by an approved settlement — reduces what is
      // open WITHOUT ever being counted as money received.
      waived: v.optional(v.number()),
      remaining: v.number(),
      status: v.string(), // PAID | PARTIAL | PENDING | OVERDUE
      updatedAt: v.number(),
    })
      .index("by_loan", ["loanId", "index"])
      .index("by_due", ["dueDate"]),

    /* ------------------------------ Collections ---------------------------- */

    collections: defineTable({
      code: v.string(), // PY-000123
      loanId: v.id("loans"),
      scheduleId: v.optional(v.id("loanSchedules")),
      clientId: v.id("clients"),
      staffId: v.id("profiles"),
      branchId: v.id("branches"),
      amount: v.number(),
      principalPortion: v.number(),
      interestPortion: v.number(),
      mode: v.string(), // CASH | UPI | BANK
      remarks: v.optional(v.string()),
      receiptNumber: v.optional(v.string()),
      receiptId: v.optional(v.id("receipts")),
      walletTxnId: v.optional(v.id("walletTransactions")),
      status: v.string(), // NORMAL | REVERSED
      reversalOfId: v.optional(v.id("collections")),
      idempotencyKey: v.optional(v.string()),
      syncStatus: v.optional(v.string()), // SYNCED | PENDING | FAILED (offline queue)
      location: v.optional(v.string()), // optional collection metadata
      createdAt: v.number(),
    })
      .index("by_loan", ["loanId", "createdAt"])
      .index("by_staff", ["staffId", "createdAt"])
      .index("by_client", ["clientId"])
      .index("by_idem", ["idempotencyKey"])
      .index("by_created", ["createdAt"]),

    receipts: defineTable({
      number: v.string(), // RCPT-261006-0007
      loanId: v.id("loans"),
      clientId: v.id("clients"),
      collectionId: v.id("collections"),
      staffId: v.id("profiles"),
      branchId: v.id("branches"),
      amount: v.number(),
      mode: v.string(),
      outstandingAfter: v.number(),
      createdAt: v.number(),
    })
      .index("by_number", ["number"])
      .index("by_client", ["clientId"])
      .index("by_staff", ["staffId", "createdAt"]),

    /* --------------------------- Cash management --------------------------- */

    cashHandovers: defineTable({
      code: v.string(), // CH-0001
      staffId: v.id("profiles"),
      branchId: v.id("branches"),
      amount: v.number(),
      status: v.string(), // REQUESTED | ACCEPTED | REJECTED
      remarks: v.optional(v.string()),
      expectedCash: v.optional(v.number()),
      bmId: v.optional(v.id("profiles")),
      resolvedAt: v.optional(v.number()),
      resolvedBy: v.optional(v.id("profiles")),
      rejectReason: v.optional(v.string()),
      requestedAt: v.number(),
    })
      .index("by_status", ["status", "requestedAt"])
      .index("by_staff", ["staffId", "requestedAt"])
      .index("by_branch", ["branchId"]),

    cashIssues: defineTable({
      code: v.string(), // CI-0001
      staffId: v.id("profiles"),
      branchId: v.id("branches"),
      bmId: v.id("profiles"),
      amount: v.number(),
      remarks: v.optional(v.string()),
      walletTxnId: v.optional(v.id("walletTransactions")),
      createdAt: v.number(),
    })
      .index("by_staff", ["staffId", "createdAt"])
      .index("by_branch", ["branchId"]),

    cashClosings: defineTable({
      profileId: v.id("profiles"),
      branchId: v.id("branches"),
      dateKey: v.string(), // YYYY-MM-DD
      opening: v.number(),
      cashReceived: v.number(),
      cashCollections: v.number(),
      disbursement: v.number(),
      handover: v.number(),
      expenses: v.number(),
      expected: v.number(),
      actual: v.number(),
      difference: v.number(),
      explanation: v.optional(v.string()),
      status: v.string(), // PENDING | APPROVED | REJECTED
      approvedBy: v.optional(v.id("profiles")),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
      .index("by_profile", ["profileId", "dateKey"])
      .index("by_date", ["dateKey"])
      .index("by_status", ["status"]),

    expenses: defineTable({
      code: v.string(), // EX-0001
      profileId: v.id("profiles"),
      branchId: v.id("branches"),
      amount: v.number(),
      category: v.string(),
      remarks: v.string(),
      status: v.string(), // PENDING | APPROVED | REJECTED
      approvedBy: v.optional(v.id("profiles")),
      idempotencyKey: v.optional(v.string()),
      createdAt: v.number(),
    })
      .index("by_branch", ["branchId", "createdAt"])
      .index("by_status", ["status"])
      .index("by_idem", ["idempotencyKey"]),

    /* ------------------------------ Accounting ----------------------------- */

    accountLedgers: defineTable({
      code: v.string(),
      name: v.string(),
      type: v.string(), // ASSET | LIABILITY | EQUITY | INCOME | EXPENSE
      normalSide: v.string(), // DEBIT | CREDIT
    }).index("by_code", ["code"]),

    journalEntries: defineTable({
      entryId: v.string(), // JE-000001
      dateKey: v.string(),
      memo: v.string(),
      refType: v.string(),
      refId: v.string(),
      lines: v.array(
        v.object({
          code: v.string(),
          debit: v.number(),
          credit: v.number(),
        }),
      ),
      branchId: v.optional(v.id("branches")),
      createdBy: v.optional(v.id("profiles")),
      createdAt: v.number(),
    })
      .index("by_date", ["dateKey"])
      .index("by_ref", ["refType", "refId"])
      .index("by_created", ["createdAt"]),

    /* -------------------------- Groups & meetings -------------------------- */

    centers: defineTable({
      code: v.string(), // CTR-SHN
      name: v.string(),
      branchId: v.id("branches"),
      village: v.string(),
      staffId: v.optional(v.id("profiles")),
      createdAt: v.number(),
    }).index("by_branch", ["branchId"]),

    groups: defineTable({
      code: v.string(), // GRP-MDG
      name: v.string(),
      centerId: v.id("centers"),
      branchId: v.id("branches"),
      createdAt: v.number(),
    }).index("by_center", ["centerId"]),

    groupMembers: defineTable({
      groupId: v.id("groups"),
      clientId: v.id("clients"),
      joinedAt: v.number(),
    }).index("by_group", ["groupId"]),

    meetings: defineTable({
      groupId: v.id("groups"),
      branchId: v.id("branches"),
      staffId: v.id("profiles"),
      dateKey: v.string(),
      present: v.array(v.string()), // client codes
      absent: v.array(v.string()),
      collectionAmount: v.number(),
      notes: v.optional(v.string()),
      createdAt: v.number(),
    }).index("by_group", ["groupId", "dateKey"]),

    /* ------------------------ Ops, audit & notifications -------------------- */

    notifications: defineTable({
      profileId: v.id("profiles"),
      title: v.string(),
      body: v.string(),
      kind: v.string(), // DUE | APPROVAL | WALLET | HANDOVER | CASH | SYSTEM | LOAN
      link: v.optional(v.string()),
      read: v.boolean(),
      createdAt: v.number(),
    }).index("by_profile", ["profileId", "createdAt"]),

    // Immutable: FinServe never exposes a delete/update path for audit logs.
    auditLogs: defineTable({
      actorId: v.optional(v.id("profiles")),
      actorName: v.string(),
      role: v.optional(v.string()),
      action: v.string(),
      entity: v.string(),
      entityId: v.optional(v.string()),
      before: v.optional(v.any()),
      after: v.optional(v.any()),
      referenceId: v.optional(v.string()),
      branchId: v.optional(v.id("branches")),
      device: v.optional(v.string()),
      createdAt: v.number(),
    })
      .index("by_created", ["createdAt"])
      .index("by_actor", ["actorId"])
      .index("by_entity", ["entity", "entityId"]),

    approvalRequests: defineTable({
      kind: v.string(), // LOAN | CASH_SHORTAGE | WALLET_LIMIT | EXPENSE | HANDOVER
      refId: v.optional(v.string()),
      branchId: v.optional(v.id("branches")),
      requestedBy: v.id("profiles"),
      amount: v.optional(v.number()),
      summary: v.string(),
      status: v.string(), // PENDING | APPROVED | REJECTED
      decidedBy: v.optional(v.id("profiles")),
      decidedAt: v.optional(v.number()),
      remark: v.optional(v.string()),
      createdAt: v.number(),
    })
      .index("by_status", ["status", "createdAt"])
      .index("by_kind", ["kind"]),

    recoveryActivities: defineTable({
      loanId: v.id("loans"),
      clientId: v.id("clients"),
      staffId: v.id("profiles"),
      branchId: v.id("branches"),
      kind: v.string(), // RECOVERY_KINDS
      notes: v.optional(v.string()),
      promisedAmount: v.optional(v.number()),
      promisedDate: v.optional(v.number()),
      createdAt: v.number(),
    })
      .index("by_loan", ["loanId", "createdAt"])
      .index("by_staff", ["staffId", "createdAt"]),

    grievances: defineTable({
      clientId: v.id("clients"),
      body: v.string(),
      status: v.string(), // OPEN | IN_REVIEW | RESOLVED
      assigneeId: v.optional(v.id("profiles")),
      resolution: v.optional(v.string()),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
      .index("by_client", ["clientId"])
      .index("by_status", ["status"]),

    devices: defineTable({
      profileId: v.id("profiles"),
      label: v.string(),
      platform: v.optional(v.string()),
      lastSeenAt: v.number(),
      revokedAt: v.optional(v.number()),
    }).index("by_profile", ["profileId"]),

    // Atomic sequence counters for human readable codes (receipts, loans...).
    counters: defineTable({
      key: v.string(),
      value: v.number(),
    }).index("by_key", ["key"]),
  },
  {
    schemaValidation: false,
  },
);

export default schema;
