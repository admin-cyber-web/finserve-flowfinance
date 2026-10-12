/**
 * FinServe demo dataset.
 *
 * Two phases so a partial failure can never leave a half-seeded database
 * (each Convex mutation is atomic):
 *
 *   seedOrg      → branches, chart of accounts, staff, wallets, products,
 *                  clients, KYC, staff history, centres/groups
 *   seedActivity → loans + schedules + historical & today's repayments,
 *                  expense, handovers/issues that normalise wallets to their
 *                  published balances, pending approvals, closings,
 *                  recovery, notifications, audit entries
 *
 * Every seeded rupee flows through the SAME operations the live app uses
 * (disburseLoan / recordCollection), so the ledgers, receipts, journals and
 * audit logs are internally consistent and fully traceable.
 */
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { ACCOUNTS, expenseEntry, handoverEntry, issueEntry } from "../finance/journal";
import { round2 } from "../finance/money";
import { generateSchedule } from "../finance/schedule";
import type { Frequency, InterestMethod, PayMode } from "../finance/types";
import {
  logAudit,
  makeCode,
  notify,
  walletBalance,
  writeJournal,
  writeWalletTx,
  type Mtx,
} from "./convexHelpers";
import { disburseLoan, recordCollection } from "./loanOps";

const DAY = 86_400_000;

/* ------------------------------- Phase one ------------------------------- */

export async function seedOrg(ctx: Mtx): Promise<{ skipped: boolean }> {
  const existing = await ctx.db.query("branches").collect();
  if (existing.length > 0) return { skipped: true };

  const now = Date.now();

  /* Branches */
  const branchDefs = [
    { code: "LKO", name: "Lucknow — Hazratganj Main", city: "Lucknow", state: "Uttar Pradesh" },
    { code: "KNP", name: "Kanpur — Civil Lines", city: "Kanpur", state: "Uttar Pradesh" },
    { code: "VNS", name: "Varanasi — Lanka", city: "Varanasi", state: "Uttar Pradesh" },
  ];
  const branches: Record<string, Id<"branches">> = {};
  for (const b of branchDefs) {
    branches[b.code] = await ctx.db.insert("branches", {
      ...b,
      status: "ACTIVE",
      createdAt: now,
    });
  }

  /* Chart of accounts */
  for (const a of ACCOUNTS) {
    await ctx.db.insert("accountLedgers", {
      code: a.code,
      name: a.name,
      type: a.type,
      normalSide: a.normalSide,
    });
  }

  /* Staff profiles */
  const profileDefs = [
    { key: "admin", name: "Aarti Mishra", staffId: "SA-10001", role: "SUPER_ADMIN", email: "admin@kiratmicrocredit.in", mobile: "9811000001", branch: "LKO", persona: "admin", status: "ACTIVE", twofa: true },
    { key: "bm", name: "Vikram Singh", staffId: "BM-20004", role: "BRANCH_MANAGER", email: "bm@kiratmicrocredit.in", mobile: "9811000002", branch: "LKO", persona: "bm", status: "ACTIVE" },
    { key: "acct", name: "Deepa Rao", staffId: "AC-30007", role: "ACCOUNTANT", email: "accounts@kiratmicrocredit.in", mobile: "9811000003", branch: "LKO", persona: "accountant", status: "ACTIVE" },
    { key: "rahul", name: "Rahul Kumar", staffId: "ST10025", role: "FIELD_STAFF", email: "rahul@kiratmicrocredit.in", mobile: "9811000004", branch: "LKO", persona: "staff", status: "ACTIVE" },
    { key: "amit", name: "Amit Verma", staffId: "ST10031", role: "FIELD_STAFF", email: "amit@kiratmicrocredit.in", mobile: "9811000005", branch: "LKO", status: "ACTIVE" },
    { key: "suresh", name: "Suresh Yadav", staffId: "ST10042", role: "FIELD_STAFF", email: "suresh@kiratmicrocredit.in", mobile: "9811000006", branch: "LKO", status: "ACTIVE" },
    { key: "priya", name: "Priya Nair", staffId: "ST10058", role: "FIELD_STAFF", email: "priya@kiratmicrocredit.in", mobile: "9811000007", branch: "KNP", status: "ACTIVE" },
    { key: "ravi", name: "Ravi Kushwaha", staffId: "ST10061", role: "FIELD_STAFF", email: "ravi@kiratmicrocredit.in", mobile: "9811000008", branch: "LKO", status: "BLOCKED" },
  ];

  const profiles: Record<string, Doc<"profiles">> = {};
  for (const p of profileDefs) {
    const id = await ctx.db.insert("profiles", {
      email: p.email,
      mobile: p.mobile,
      name: p.name,
      staffId: p.staffId,
      role: p.role,
      branchId: branches[p.branch],
      status: p.status,
      persona: p.persona,
      joiningDate: now - (p.role === "SUPER_ADMIN" ? 5 : 2) * 365 * DAY,
      twoFactorEnabled: p.twofa ?? false,
      createdAt: now,
    });
    profiles[p.key] = (await ctx.db.get(id))!;
    await logAudit(ctx, {
      actorName: "system",
      action: "STAFF_CREATED",
      entity: "profiles",
      entityId: p.staffId,
      after: { name: p.name, role: p.role, status: p.status, branch: p.branch },
      branchId: branches[p.branch],
    });
  }

  /* Working wallets (approved limits only — balances are derived) */
  const walletTargets: Record<string, { limit: number; target: number }> = {
    rahul: { limit: 400000, target: 275430 },
    amit: { limit: 400000, target: 210000 },
    suresh: { limit: 400000, target: 399000 },
    priya: { limit: 300000, target: 185000 },
    ravi: { limit: 200000, target: 95000 },
  };
  const wallets: Record<string, Doc<"wallets">> = {};
  for (const [key, cfg] of Object.entries(walletTargets)) {
    const p = profiles[key];
    const id = await ctx.db.insert("wallets", {
      profileId: p._id,
      branchId: p.branchId!,
      walletLimit: cfg.limit,
      status: "ACTIVE",
      createdAt: now,
    });
    wallets[key] = (await ctx.db.get(id))!;
    await writeWalletTx(ctx, {
      walletId: wallets[key]._id,
      profileId: p._id,
      branchId: p.branchId!,
      type: "OPENING_ALLOCATION",
      amount: cfg.limit,
      direction: "CREDIT",
      referenceType: "OPENING",
      referenceId: p.staffId,
      createdBy: profiles.admin._id,
      approvedBy: profiles.admin._id,
      remarks: `Working cash limit sanctioned to ${p.name}`,
      createdAt: now - 45 * DAY,
    });
    await logAudit(ctx, {
      actorId: profiles.admin._id,
      actorName: profiles.admin.name,
      role: profiles.admin.role,
      action: "WALLET_LIMIT_SET",
      entity: "wallets",
      entityId: p.staffId,
      after: { walletLimit: cfg.limit },
      branchId: p.branchId,
    });
  }

  /* Loan products */
  const productDefs = [
    { key: "WMC", code: "PRC-WMC", name: "Weekly Micro Credit", min: 10000, max: 100000, rate: 24, method: "FLAT", tenure: 26, freq: "WEEKLY", fee: 250, pct: 1, grace: 0, ratio: 50 },
    { key: "BGL", code: "PRC-BGL", name: "Business Growth Loan", min: 50000, max: 500000, rate: 18, method: "REDUCING", tenure: 24, freq: "MONTHLY", fee: 1000, pct: 0.5, grace: 0, ratio: 55 },
    { key: "GL", code: "PRC-GL", name: "Gold Loan", min: 25000, max: 300000, rate: 14, method: "REDUCING", tenure: 12, freq: "MONTHLY", fee: 500, pct: 0.25, grace: 0, ratio: 60 },
    { key: "EL", code: "PRC-EL", name: "Emergency Loan", min: 5000, max: 50000, rate: 30, method: "FLAT", tenure: 12, freq: "WEEKLY", fee: 100, pct: 0, grace: 3, ratio: 45 },
  ];
  const products: Record<string, Doc<"loanProducts">> = {};
  for (const p of productDefs) {
    const id = await ctx.db.insert("loanProducts", {
      code: p.code,
      name: p.name,
      minAmount: p.min,
      maxAmount: p.max,
      interestRate: p.rate,
      interestMethod: p.method,
      tenure: p.tenure,
      frequency: p.freq,
      processingFee: p.fee,
      chargePercent: p.pct,
      graceDays: p.grace,
      maxObligationRatio: p.ratio,
      status: "ACTIVE",
      createdAt: now,
    });
    products[p.key] = (await ctx.db.get(id))!;
  }

  /* Centres & groups */
  const shn = await ctx.db.insert("centers", {
    code: "CTR-SHN",
    name: "Shiv Nagar Centre",
    branchId: branches.LKO,
    village: "Shiv Nagar",
    staffId: profiles.rahul._id,
    createdAt: now,
  });
  await ctx.db.insert("centers", {
    code: "CTR-BAR",
    name: "Barra Centre",
    branchId: branches.KNP,
    village: "Barra",
    staffId: profiles.priya._id,
    createdAt: now,
  });
  const mdg = await ctx.db.insert("groups", {
    code: "GRP-MDG",
    name: "Maa Durga Group",
    centerId: shn,
    branchId: branches.LKO,
    createdAt: now,
  });
  await ctx.db.insert("groups", {
    code: "GRP-SHY",
    name: "Shyam Lal Group",
    centerId: shn,
    branchId: branches.LKO,
    createdAt: now,
  });

  /* Clients */
  const clientDefs = [
    { code: "C-000119", name: "Sita Devi", father: "Ram Lal", age: 34, gender: "FEMALE", mobile: "9826011119", village: "Rajapur", occupation: "Tailoring", monthly: 9000, household: 22000, family: 5, staff: "rahul", kyc: "VERIFIED", group: true },
    { code: "C-000121", name: "Geeta Kumari", father: "Shyam Kishore", age: 29, gender: "FEMALE", mobile: "9826011121", village: "Bhainsa", occupation: "Agriculture labour", monthly: 8500, household: 19000, family: 4, staff: "rahul", kyc: "VERIFIED", group: true },
    { code: "C-000123", name: "Anita Devi", father: "Ramesh Prasad", age: 41, gender: "FEMALE", mobile: "9826011123", village: "Kishunpur", occupation: "Shop assistance", monthly: 7500, household: 21000, family: 6, staff: "rahul", kyc: "VERIFIED" },
    { code: "C-000124", name: "Suresh Yadav", father: "Jagdish Yadav", age: 45, gender: "MALE", mobile: "9826011124", village: "Chandaur", occupation: "Farming", monthly: 12000, household: 26000, family: 5, staff: "amit", kyc: "VERIFIED" },
    { code: "C-000126", name: "Ravi Shankar", father: "Mohan Lal", age: 38, gender: "MALE", mobile: "9826011126", village: "Nigoha", occupation: "Electrician", monthly: 14000, household: 24000, family: 4, staff: "amit", kyc: "PENDING" },
    { code: "C-000127", name: "Meena Sharma", father: "Dinesh Sharma", age: 33, gender: "FEMALE", mobile: "9826011127", village: "Bakshi Ka Talab", occupation: "Boutique owner", monthly: 16000, household: 30000, family: 3, staff: "amit", kyc: "VERIFIED" },
    { code: "C-000128", name: "Ramesh Kumar", father: "Munna Lal", age: 42, gender: "MALE", mobile: "9876512345", village: "Shiv Nagar", occupation: "Kirana shop", monthly: 18000, household: 24000, family: 4, staff: "rahul", kyc: "VERIFIED", group: true },
    { code: "C-000129", name: "Kavita Singh", father: "Amar Nath", age: 36, gender: "FEMALE", mobile: "9826011129", village: "Gomti Nagar", occupation: "Private teacher", monthly: 15000, household: 28000, family: 4, staff: "rahul", kyc: "PENDING" },
    { code: "C-000130", name: "Pooja Yadav", father: "Net Ram", age: 27, gender: "FEMALE", mobile: "9826011130", village: "Mauntha", occupation: "Embroidery", monthly: 8000, household: 18000, family: 3, staff: "suresh", kyc: "VERIFIED", group: true, reassigned: true },
    { code: "C-000131", name: "Deepak Kushwaha", father: "Ramesh Chandra", age: 47, gender: "MALE", mobile: "9826011131", village: "Sarai Shahjadi", occupation: "Hardware shop", monthly: 22000, household: 35000, family: 6, staff: "suresh", kyc: "VERIFIED" },
    { code: "C-000132", name: "Shabnam Bano", father: "Iqbal Ahmed", age: 31, gender: "FEMALE", mobile: "9826011132", village: "Amaniganj", occupation: "Beauty parlour", monthly: 11000, household: 20000, family: 4, staff: "suresh", kyc: "PENDING" },
    { code: "C-000133", name: "Vijay Verma", father: "Hari Om", age: 39, gender: "MALE", mobile: "9826011133", village: "Barra", occupation: "Transport", monthly: 17000, household: 29000, family: 5, staff: "priya", kyc: "VERIFIED" },
    { code: "C-000134", name: "Lakshmi Devi", father: "Sheo Prasad", age: 52, gender: "FEMALE", mobile: "9826011134", village: "Shyam Nagar", occupation: "Vegetable vending", monthly: 7000, household: 16000, family: 4, staff: "priya", kyc: "VERIFIED" },
    { code: "C-000135", name: "Arun Kumar", father: "Bhagwan Das", age: 26, gender: "MALE", mobile: "9826011135", village: "Govind Nagar", occupation: "Mechanic", monthly: 13000, household: 17000, family: 3, staff: "ravi", kyc: "VERIFIED" },
  ];

  const clients: Record<string, Doc<"clients">> = {};
  for (const c of clientDefs) {
    const staff = profiles[c.staff];
    const id = await ctx.db.insert("clients", {
      code: c.code,
      name: c.name,
      fatherName: c.father,
      age: c.age,
      gender: c.gender,
      mobile: c.mobile,
      address: `House ${10 + (c.age % 40)}, ${c.village}`,
      village: c.village,
      district: staff.branchId === branches.KNP ? "Kanpur Nagar" : "Lucknow",
      state: "Uttar Pradesh",
      pin: staff.branchId === branches.KNP ? "208001" : "226001",
      occupation: c.occupation,
      monthlyIncome: c.monthly,
      householdIncome: c.household,
      familyMembers: c.family,
      branchId: staff.branchId!,
      assignedTo: staff._id,
      createdBy: staff._id,
      kycStatus: c.kyc,
      kycDocType: "Aadhaar",
      kycDocRef: `XXXX-XXXX-${String(c.age).padStart(4, "0")}`,
      verifiedBy: c.kyc === "VERIFIED" ? profiles.bm._id : undefined,
      verifiedAt: c.kyc === "VERIFIED" ? now - 60 * DAY : undefined,
      centerCode: "CTR-SHN",
      groupCode: c.group ? "GRP-MDG" : undefined,
      status: "ACTIVE",
      searchText: `${c.name} ${c.mobile} ${c.code} ${c.village}`.toLowerCase(),
      createdAt: now - (90 + (c.age % 30)) * DAY,
    });
    clients[c.code] = (await ctx.db.get(id))!;

    // Staff assignment history (never deleted; reassignments append).
    await ctx.db.insert("clientStaffHistory", {
      clientId: clients[c.code]._id,
      toStaffId: staff._id,
      reason: "Client onboarding",
      createdBy: staff._id,
      createdAt: now - (90 + (c.age % 30)) * DAY,
    });
    if (c.reassigned) {
      await ctx.db.insert("clientStaffHistory", {
        clientId: clients[c.code]._id,
        fromStaffId: profiles.rahul._id,
        toStaffId: staff._id,
        reason: "Centre transfer — reassigned from Rahul Kumar",
        createdBy: profiles.bm._id,
        createdAt: now - 20 * DAY,
      });
    }

    await ctx.db.insert("clientDocuments", {
      clientId: clients[c.code]._id,
      type: "KYC",
      fileName: `${c.code.toLowerCase()}-aadhaar.pdf`,
      status: c.kyc === "VERIFIED" ? "VERIFIED" : "PENDING_VERIFICATION",
      uploadedBy: staff._id,
      verifiedBy: c.kyc === "VERIFIED" ? profiles.bm._id : undefined,
      createdAt: now - (88 + (c.age % 30)) * DAY,
    });
  }

  await ctx.db.insert("clientDocuments", {
    clientId: clients["C-000128"]._id,
    type: "CLIENT_PHOTO",
    fileName: "ramesh-kumar-selfie.jpg",
    status: "VERIFIED",
    uploadedBy: profiles.rahul._id,
    verifiedBy: profiles.bm._id,
    createdAt: now - 88 * DAY,
  });
  await ctx.db.insert("clientNotes", {
    clientId: clients["C-000128"]._id,
    profileId: profiles.rahul._id,
    body: "Shop front renamed — new board photographed during September visit. Repayment history clean.",
    createdAt: now - 12 * DAY,
  });

  for (const code of ["C-000128", "C-000119", "C-000121", "C-000130"]) {
    await ctx.db.insert("groupMembers", {
      groupId: mdg,
      clientId: clients[code]._id,
      joinedAt: now - 85 * DAY,
    });
  }

  /* Client portal profile (demo persona) */
  await ctx.db.insert("profiles", {
    name: "Ramesh Kumar",
    staffId: "C-000128",
    role: "CLIENT",
    branchId: branches.LKO,
    status: "ACTIVE",
    persona: "client",
    clientId: clients["C-000128"]._id,
    mobile: "9876512345",
    email: "ramesh@client.kiratmicrocredit.in",
    createdAt: now - 85 * DAY,
  });

  return { skipped: false };
}

/* ------------------------------- Phase two ------------------------------- */

interface LoanCfg {
  client: string;
  product: string;
  staff: string;
  amount: number;
  daysAgo: number;
  payCount: number;
  mode?: PayMode;
  today?: { kind: "full" | "partial"; remaining?: number; mode?: PayMode };
}

const LOAN_CFGS: LoanCfg[] = [
  { client: "C-000128", product: "WMC", staff: "rahul", amount: 25000, daysAgo: 35, payCount: 4, mode: "CASH", today: { kind: "partial", remaining: 500, mode: "CASH" } },
  { client: "C-000119", product: "WMC", staff: "rahul", amount: 18000, daysAgo: 21, payCount: 2, mode: "CASH", today: { kind: "full", mode: "CASH" } },
  { client: "C-000121", product: "WMC", staff: "rahul", amount: 15000, daysAgo: 14, payCount: 1, mode: "UPI", today: { kind: "partial", remaining: 700, mode: "CASH" } },
  { client: "C-000123", product: "EL", staff: "rahul", amount: 12000, daysAgo: 10, payCount: 0, today: { kind: "full", mode: "CASH" } },
  { client: "C-000124", product: "BGL", staff: "amit", amount: 80000, daysAgo: 62, payCount: 1, mode: "UPI" },
  { client: "C-000126", product: "WMC", staff: "amit", amount: 20000, daysAgo: 14, payCount: 1, mode: "CASH", today: { kind: "full", mode: "CASH" } },
  { client: "C-000127", product: "WMC", staff: "amit", amount: 12000, daysAgo: 28, payCount: 3, mode: "UPI", today: { kind: "full", mode: "UPI" } },
  { client: "C-000130", product: "WMC", staff: "suresh", amount: 22000, daysAgo: 21, payCount: 2, mode: "CASH", today: { kind: "full", mode: "CASH" } },
  { client: "C-000131", product: "GL", staff: "suresh", amount: 60000, daysAgo: 59, payCount: 1, mode: "BANK" },
  { client: "C-000132", product: "WMC", staff: "suresh", amount: 10000, daysAgo: 0, payCount: 0 },
  { client: "C-000133", product: "WMC", staff: "priya", amount: 16000, daysAgo: 28, payCount: 3, mode: "CASH", today: { kind: "full", mode: "CASH" } },
  { client: "C-000134", product: "WMC", staff: "priya", amount: 14000, daysAgo: 42, payCount: 5, mode: "UPI", today: { kind: "full", mode: "UPI" } },
  { client: "C-000135", product: "WMC", staff: "ravi", amount: 15000, daysAgo: 56, payCount: 0 },
];

export async function seedActivity(ctx: Mtx): Promise<{ skipped: boolean }> {
  const existingLoans = await ctx.db.query("loans").collect();
  if (existingLoans.length > 0) return { skipped: true };

  const now = Date.now();
  const startToday = now - (now % DAY);

  const loadProfiles = async () => {
    const all = await ctx.db.query("profiles").collect();
    const byStaffId: Record<string, Doc<"profiles">> = {};
    const byPersona: Record<string, Doc<"profiles">> = {};
    for (const p of all) {
      byStaffId[p.staffId] = p;
      if (p.persona) byPersona[p.persona] = p;
    }
    return { all, byStaffId, byPersona };
  };
  const { byStaffId, byPersona } = await loadProfiles();
  const admin = byPersona.admin;
  const bm = byPersona.bm;
  if (!admin || !bm) return { skipped: true };

  const clientRows = await ctx.db.query("clients").collect();
  const clientsByCode: Record<string, Doc<"clients">> = {};
  for (const c of clientRows) clientsByCode[c.code] = c;

  const productRows = await ctx.db.query("loanProducts").collect();
  const productsByCode: Record<string, Doc<"loanProducts">> = {};
  for (const p of productRows) productsByCode[p.code] = p;

  /* ---- Loans, applications, schedules, repayments ---- */
  for (const cfg of LOAN_CFGS) {
    const client = clientsByCode[cfg.client];
    const product = productsByCode[cfg.product];
    const staff = byStaffId[cfg.staff];
    if (!client || !product || !staff || !staff.branchId) continue;

    const charges = round2(
      product.processingFee + (cfg.amount * product.chargePercent) / 100,
    );
    const preview = generateSchedule({
      principal: cfg.amount,
      annualRate: product.interestRate,
      method: product.interestMethod as InterestMethod,
      frequency: product.frequency as Frequency,
      tenure: product.tenure,
      disbursedOn: startToday - cfg.daysAgo * DAY,
      graceDays: product.graceDays,
    });

    const appId = await makeCode(ctx, "application", "LA-", 6);
    const createdAt = startToday - (cfg.daysAgo + 2) * DAY;
    const applicationId = await ctx.db.insert("loanApplications", {
      appId,
      clientId: client._id,
      productId: product._id,
      amount: cfg.amount,
      staffId: staff._id,
      branchId: staff.branchId,
      status: "SUBMITTED",
      history: [
        {
          actorId: staff._id,
          actorName: staff.name,
          role: staff.role,
          action: "SUBMITTED",
          at: createdAt,
        },
        {
          actorId: bm._id,
          actorName: bm.name,
          role: bm.role,
          action: "APPROVED",
          remark: "Policy check passed — income and repayment history reviewed.",
          at: createdAt + 6 * 3600_000,
        },
      ],
      submittedAt: createdAt,
      decidedAt: createdAt + 6 * 3600_000,
      createdAt,
    });

    const loanId = await makeCode(ctx, "loan", "LN-", 6);
    const loanDocId = await ctx.db.insert("loans", {
      loanId,
      applicationId,
      clientId: client._id,
      productId: product._id,
      staffId: staff._id,
      branchId: staff.branchId,
      principal: cfg.amount,
      interestTotal: preview.totalInterest,
      charges,
      totalPayable: 0,
      installment: preview.installment,
      frequency: product.frequency,
      tenure: product.tenure,
      interestRate: product.interestRate,
      interestMethod: product.interestMethod,
      status: "APPROVED",
      outstanding: 0,
      paidTotal: 0,
      approvedBy: bm._id,
      approvedAt: createdAt + 6 * 3600_000,
      overdueDays: 0,
      createdAt,
    });

    await ctx.db.patch(applicationId, {
      status: "APPROVED",
      loanId: loanDocId,
    });

    const disbursedAt = startToday - cfg.daysAgo * DAY;
    await disburseLoan(ctx, { loanId: loanDocId, actor: staff, now: disbursedAt });
    await ctx.db.patch(applicationId, { status: "DISBURSED" });

    // Historical repayments (before today).
    const rows = (await ctx.db
      .query("loanSchedules")
      .withIndex("by_loan", (q) => q.eq("loanId", loanDocId))
      .collect())
      .sort((a, b) => a.index - b.index);

    for (let i = 0; i < cfg.payCount && i < rows.length; i++) {
      const row = rows[i];
      if (row.dueDate >= startToday) break;
      await recordCollection(ctx, {
        loanId: loanDocId,
        actor: staff,
        amount: row.totalDue,
        mode: cfg.mode ?? "CASH",
        remarks: "Regular installment",
        idempotencyKey: `seed:${loanId}:r${row.index}`,
        now: Math.min(row.dueDate + 9 * 3600_000, now - 60_000),
      });
    }

    // Today's collection activity.
    if (cfg.today && rows[cfg.payCount]) {
      const row = rows[cfg.payCount];
      const amount =
        cfg.today.kind === "partial"
          ? round2(row.totalDue - (cfg.today.remaining ?? 0))
          : row.totalDue;
      if (amount > 0) {
        await recordCollection(ctx, {
          loanId: loanDocId,
          actor: staff,
          amount,
          mode: cfg.today.mode ?? "CASH",
          remarks:
            cfg.today.kind === "partial"
              ? "Part payment — balance promised this week"
              : "Regular installment",
          idempotencyKey: `seed:${loanId}:today`,
          now: Math.min(
            Math.max(startToday + 6 * 3600_000, row.dueDate) +
              (LOAN_CFGS.indexOf(cfg) % 6) * 780_000,
            now - 60_000,
          ),
        });
      }
    }
  }

  /* ---- Approved expense from staff cash ---- */
  const rahul = byStaffId.ST10025!;
  const rahulWallet = await ctx.db
    .query("wallets")
    .withIndex("by_profile", (q) => q.eq("profileId", rahul._id))
    .unique();
  if (rahulWallet && rahul.branchId) {
    const expenseCode = await makeCode(ctx, "expense", "EX-", 5);
    await ctx.db.insert("expenses", {
      code: expenseCode,
      profileId: rahul._id,
      branchId: rahul.branchId,
      amount: 10000,
      category: "Field travel & printing",
      remarks: "September route travel, repayment card printing, centre refreshments",
      status: "APPROVED",
      approvedBy: bm._id,
      createdAt: now - 4 * DAY,
    });
    await writeWalletTx(ctx, {
      walletId: rahulWallet._id,
      profileId: rahul._id,
      branchId: rahul.branchId,
      type: "EXPENSE",
      amount: 10000,
      direction: "DEBIT",
      referenceType: "EXPENSE",
      referenceId: expenseCode,
      createdBy: rahul._id,
      approvedBy: bm._id,
      remarks: "Approved field expense",
      createdAt: now - 4 * DAY,
    });
    await writeJournal(
      ctx,
      expenseEntry({
        amount: 10000,
        memo: `Approved expense ${expenseCode} — Rahul Kumar`,
        refId: expenseCode,
      }),
      { branchId: rahul.branchId, createdBy: rahul._id, createdAt: now - 4 * DAY },
    );
  }

  /* ---- Normalise wallets to their published balances (ledger only) ---- */
  const targets: Record<string, number> = {
    ST10025: 275430,
    ST10031: 210000,
    ST10042: 399000,
    ST10058: 185000,
    ST10061: 95000,
  };
  for (const [staffId, target] of Object.entries(targets)) {
    const staff = byStaffId[staffId];
    if (!staff?.branchId) continue;
    const wallet = await ctx.db
      .query("wallets")
      .withIndex("by_profile", (q) => q.eq("profileId", staff._id))
      .unique();
    if (!wallet) continue;
    const balance = await walletBalance(ctx, wallet._id);
    const delta = round2(balance - target);
    if (Math.abs(delta) < 1) continue;

    if (delta > 0) {
      // Staff hands surplus cash to the BM.
      const code = await makeCode(ctx, "handover", "CH-", 5);
      await ctx.db.insert("cashHandovers", {
        code,
        staffId: staff._id,
        branchId: staff.branchId,
        amount: delta,
        status: "ACCEPTED",
        remarks: "End-of-day surplus working cash returned to branch",
        expectedCash: balance,
        bmId: bm._id,
        resolvedAt: now - 1 * DAY,
        resolvedBy: bm._id,
        requestedAt: now - 1 * DAY,
      });
      await writeWalletTx(ctx, {
        walletId: wallet._id,
        profileId: staff._id,
        branchId: staff.branchId,
        type: "CASH_HANDOVER",
        amount: delta,
        direction: "DEBIT",
        referenceType: "HANDOVER",
        referenceId: code,
        createdBy: staff._id,
        approvedBy: bm._id,
        remarks: "Cash handed to Branch Manager",
        createdAt: now - 1 * DAY,
      });
      await writeJournal(
        ctx,
        handoverEntry({ amount: delta, memo: `Cash handover ${code} — ${staff.name}`, refId: code }),
        { branchId: staff.branchId, createdBy: staff._id, createdAt: now - 1 * DAY },
      );
      await notify(ctx, staff._id, {
        title: "Cash handover accepted",
        body: `₹${delta.toLocaleString("en-IN")} received by Vikram Singh. Handover ${code}.`,
        kind: "HANDOVER",
      });
    } else {
      // BM issues fresh working cash to top the wallet back up.
      const amount = round2(-delta);
      const code = await makeCode(ctx, "issue", "CI-", 5);
      await ctx.db.insert("cashIssues", {
        code,
        staffId: staff._id,
        branchId: staff.branchId,
        bmId: bm._id,
        amount,
        remarks: "Working cash replenished against returned collections",
        createdAt: now - 1 * DAY,
      });
      await writeWalletTx(ctx, {
        walletId: wallet._id,
        profileId: staff._id,
        branchId: staff.branchId,
        type: "CASH_ISSUE",
        amount,
        direction: "CREDIT",
        referenceType: "ISSUE",
        referenceId: code,
        createdBy: bm._id,
        approvedBy: bm._id,
        remarks: "Additional working cash issued by BM",
        createdAt: now - 1 * DAY,
      });
      await writeJournal(
        ctx,
        issueEntry({ amount, memo: `Cash issue ${code} — ${staff.name}`, refId: code }),
        { branchId: staff.branchId, createdBy: bm._id, createdAt: now - 1 * DAY },
      );
      await notify(ctx, staff._id, {
        title: "Wallet replenished",
        body: `₹${amount.toLocaleString("en-IN")} working cash issued by Vikram Singh.`,
        kind: "WALLET",
      });
    }
  }

  /* ---- Pending items for the BM / Admin queues ---- */
  const pendingApps: { client: string; product: string; staff: string; amount: number }[] = [
    { client: "C-000129", product: "WMC", staff: "ST10025", amount: 30000 },
    { client: "C-000131", product: "BGL", staff: "ST10042", amount: 90000 },
  ];
  for (const p of pendingApps) {
    const client = clientsByCode[p.client];
    const product = productsByCode[p.product];
    const staff = byStaffId[p.staff];
    if (!client || !product || !staff || !staff.branchId) continue;
    const appId = await makeCode(ctx, "application", "LA-", 6);
    await ctx.db.insert("loanApplications", {
      appId,
      clientId: client._id,
      productId: product._id,
      amount: p.amount,
      staffId: staff._id,
      branchId: staff.branchId,
      status: "SUBMITTED",
      history: [
        {
          actorId: staff._id,
          actorName: staff.name,
          role: staff.role,
          action: "SUBMITTED",
          remark: "Client requested additional working capital",
          at: now - 12 * 3600_000,
        },
      ],
      submittedAt: now - 12 * 3600_000,
      createdAt: now - 12 * 3600_000,
    });
    await logAudit(ctx, {
      actorId: staff._id,
      actorName: staff.name,
      role: staff.role,
      action: "LOAN_APPLIED",
      entity: "loanApplications",
      entityId: appId,
      after: { amount: p.amount, product: product.name, client: client.name },
      branchId: staff.branchId,
    });
  }

  /* Pending cash handover request (staff → BM) */
  const amit = byStaffId.ST10031!;
  if (amit.branchId) {
    await ctx.db.insert("cashHandovers", {
      code: await makeCode(ctx, "handover", "CH-", 5),
      staffId: amit._id,
      branchId: amit.branchId,
      amount: 25000,
      status: "REQUESTED",
      remarks: "Surplus cash before market day travel",
      requestedAt: now - 3 * 3600_000,
    });
  }

  /* Yesterday's cash closing with a shortage awaiting BM review */
  if (rahul.branchId) {
    const closingInput = {
      opening: 45000,
      cashReceived: 0,
      cashCollections: 18600,
      disbursement: 12000,
      handover: 30000,
      expenses: 0,
    };
    const expected =
      closingInput.opening +
      closingInput.cashReceived +
      closingInput.cashCollections -
      closingInput.disbursement -
      closingInput.handover -
      closingInput.expenses;
    const actual = expected - 250;
    await ctx.db.insert("cashClosings", {
      profileId: rahul._id,
      branchId: rahul.branchId,
      dateKey: new Date(now - DAY + 5.5 * 3600_000).toISOString().slice(0, 10),
      ...closingInput,
      expected,
      actual,
      difference: actual - expected,
      explanation:
        "₹250 counted short at closing — recounted twice, ATM deposit slip for ₹250 under verification.",
      status: "PENDING",
      createdAt: now - 20 * 3600_000,
      updatedAt: now - 20 * 3600_000,
    });
    await ctx.db.insert("approvalRequests", {
      kind: "CASH_SHORTAGE",
      refId: `CLOSING:${rahul.staffId}:${now - DAY}`,
      branchId: rahul.branchId,
      requestedBy: rahul._id,
      amount: 250,
      summary: `Cash shortage ₹250 — Rahul Kumar closing (${new Date(now - DAY).toLocaleDateString("en-IN")})`,
      status: "PENDING",
      createdAt: now - 20 * 3600_000,
    });
  }

  /* Wallet limit change request */
  await ctx.db.insert("approvalRequests", {
    kind: "WALLET_LIMIT",
    refId: amit.staffId,
    branchId: amit.branchId,
    requestedBy: bm._id,
    amount: 500000,
    summary: "Raise Amit Verma wallet limit ₹4,00,000 → ₹5,00,000 (market-week demand)",
    status: "PENDING",
    createdAt: now - 26 * 3600_000,
  });

  /* ---- Recovery activity & grievance on the overdue book ---- */
  const arunLoan = (await ctx.db.query("loans").collect()).find(
    (l) => l.loanId && l.clientId === clientsByCode["C-000135"]._id,
  );
  if (arunLoan && rahul.branchId) {
    await ctx.db.insert("recoveryActivities", {
      loanId: arunLoan._id,
      clientId: arunLoan.clientId,
      staffId: bm._id,
      branchId: arunLoan.branchId,
      kind: "VISIT",
      notes: "BM visited client premises — shop closed, family confirmed travel.",
      createdAt: now - 2 * DAY,
    });
    await ctx.db.insert("recoveryActivities", {
      loanId: arunLoan._id,
      clientId: arunLoan.clientId,
      staffId: bm._id,
      branchId: arunLoan.branchId,
      kind: "PROMISE_TO_PAY",
      notes: "Promise to clear two installments by Friday.",
      promisedAmount: 2400,
      promisedDate: now + 3 * DAY,
      createdAt: now - 1 * DAY,
    });
  }

  await ctx.db.insert("grievances", {
    clientId: clientsByCode["C-000119"]._id,
    body: "Due date falls on the festival week — requests a two-day shift for October installments.",
    status: "OPEN",
    assigneeId: bm._id,
    createdAt: now - 3 * DAY,
    updatedAt: now - 3 * DAY,
  });

  /* ---- Centre meeting ---- */
  const mdgGroup = (await ctx.db.query("groups").collect()).find(
    (g) => g.code === "GRP-MDG",
  );
  if (mdgGroup) {
    await ctx.db.insert("meetings", {
      groupId: mdgGroup._id,
      branchId: mdgGroup.branchId,
      staffId: rahul._id,
      dateKey: new Date(now - 3 * DAY + 5.5 * 3600_000).toISOString().slice(0, 10),
      present: ["C-000128", "C-000119", "C-000121"],
      absent: ["C-000130"],
      collectionAmount: 2400,
      notes: "Weekly meeting — two members on leave, collection deposited with branch.",
      createdAt: now - 3 * DAY,
    });
  }

  /* ---- Status sweep: derive every loan's status from its schedule ---- */
  for (const loan of await ctx.db.query("loans").collect()) {
    const rows = await ctx.db
      .query("loanSchedules")
      .withIndex("by_loan", (q) => q.eq("loanId", loan._id))
      .collect();
    const outstanding = round2(
      rows.reduce((s, r) => s + Math.max(0, r.totalDue - r.paid), 0),
    );
    const paidTotal = round2(rows.reduce((s, r) => s + r.paid, 0));
    const overdue = rows.some((r) => r.paid < r.totalDue && r.dueDate < now);
    const openRows = rows.filter((r) => r.paid < r.totalDue);
    await ctx.db.patch(loan._id, {
      outstanding,
      paidTotal,
      status:
        outstanding <= 0
          ? "CLOSED"
          : loan.disbursedAt
            ? overdue
              ? "OVERDUE"
              : "ACTIVE"
            : loan.status,
      nextDueDate: openRows[0]?.dueDate ?? null,
      totalPayable: round2(rows.reduce((s, r) => s + r.totalDue, 0)),
    });
  }

  /* ---- Notifications for the day ---- */
  const notifTargets: [Doc<"profiles">, string, string, string][] = [
    [bm, "2 loan applications awaiting approval", "Kavita Singh (₹30,000) and Deepak Kushwaha (₹90,000) are waiting for your decision.", "APPROVAL"],
    [bm, "Cash shortage report", "Rahul Kumar reported a ₹250 shortage in yesterday's closing — explanation attached.", "CASH"],
    [admin, "Wallet limit request", "Vikram Singh requested a ₹5,00,000 wallet limit for Amit Verma.", "WALLET"],
    [rahul, "Payments due today", "4 clients have installments due today. Collect before 6 PM.", "DUE"],
    [amit, "Handover requested", "Your ₹25,000 cash handover request is pending with the Branch Manager.", "HANDOVER"],
    [byStaffId.ST10042!, "New client assigned", "Pooja Yadav (C-000130) was reassigned to you on 20 days ago.", "SYSTEM"],
    [byPersona.accountant!, "Day book ready", "Journal entries for the last 7 days are available in Accounting → Journal.", "SYSTEM"],
  ];
  for (const [profile, title, body, kind] of notifTargets) {
    if (!profile) continue;
    await notify(ctx, profile._id, { title, body, kind });
  }

  return { skipped: false };
}
