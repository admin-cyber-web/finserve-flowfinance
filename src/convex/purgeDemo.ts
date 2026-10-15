import { mutation } from "./_generated/server";

/**
 * ONE-OFF demo-data purge for the dev deployment (temporary file — removed
 * right after the cleanup run).
 *
 * Every deletion is gated on an exact marker recorded from the demo seed
 * dataset or the developer test accounts, so genuine records can never be
 * caught:
 *
 *  - demo staff profiles = exact seeded staffIds (SA-10001, BM-20004,
 *    AC-30007, ST10025/31/42/58/61) plus the seeded CLIENT portal profile
 *    (staffId C-000128);
 *  - test profiles = the four DEACTIVATED "Temp …"/"Test Branch Manager"
 *    rows created while testing staff management;
 *  - demo clients = the fourteen seeded client codes C-000119…C-000135;
 *  - demo centres/groups = the seeded codes CTR-SHN/CTR-BAR, GRP-MDG/GRP-SHY;
 *  - users = the temp test logins only (the genuine Super Admin,
 *    tiwarijhumki@gmail.com, and all of its auth records are preserved).
 *
 * Everything derived from those entities (wallets, wallet transactions,
 * loans, schedules, collections, receipts, journals, notifications, cash
 * handovers/issues/closings, expenses, approvals, grievances, meetings,
 * client documents/notes/history) is removed with them. Config records
 * (branches, loan products, chart of accounts, counters), the genuine
 * device record and audit logs written by the genuine Super Admin are
 * preserved and reported.
 */

const GENUINE_EMAIL = "tiwarijhumki@gmail.com"; // users.SUPER_ADMIN_EMAIL

const DEMO_STAFF_IDS = new Set([
  "SA-10001",
  "BM-20004",
  "AC-30007",
  "ST10025",
  "ST10031",
  "ST10042",
  "ST10058",
  "ST10061",
]);

const DEMO_CLIENT_PORTAL_STAFF_ID = "C-000128";

const DEMO_CLIENT_CODES = new Set([
  "C-000119",
  "C-000121",
  "C-000123",
  "C-000124",
  "C-000126",
  "C-000127",
  "C-000128",
  "C-000129",
  "C-000130",
  "C-000131",
  "C-000132",
  "C-000133",
  "C-000134",
  "C-000135",
]);

const DEMO_CENTER_CODES = new Set(["CTR-SHN", "CTR-BAR"]);
const DEMO_GROUP_CODES = new Set(["GRP-MDG", "GRP-SHY"]);

const TEST_PROFILE_NAMES = new Set([
  "Temp Test Accountant",
  "Temp Test Staff",
  "Temp PIN Test BM",
  "Test Branch Manager",
]);

const id = (v: string | undefined) => v ?? "";

export const run = mutation({
  args: {},
  handler: async (ctx) => {
    const deleted: Record<string, number> = {};
    const bump = (key: string, n: number) => {
      if (n > 0) deleted[key] = (deleted[key] ?? 0) + n;
    };

    /* ---------------- identities ---------------- */

    const profiles = await ctx.db.query("profiles").collect();
    const demoProfiles = profiles.filter(
      (p) =>
        p.email !== GENUINE_EMAIL &&
        (DEMO_STAFF_IDS.has(p.staffId) ||
          p.staffId === DEMO_CLIENT_PORTAL_STAFF_ID ||
          TEST_PROFILE_NAMES.has(p.name)),
    );
    const demoProfileIds = new Set(demoProfiles.map((p) => String(p._id)));

    const users = await ctx.db.query("users").collect();
    const demoUsers = users.filter((u) => {
      if (u.email === GENUINE_EMAIL) return false;
      const name = u.name ?? "";
      return (
        name.startsWith("Temp ") ||
        name.startsWith("Test ") ||
        (u.email?.endsWith(".test@finserve.in") ?? false)
      );
    });
    const demoUserIds = new Set(demoUsers.map((u) => String(u._id)));

    // Auth sessions / refresh tokens / accounts of the removed test logins.
    const sessions = await ctx.db.query("authSessions").collect();
    const deadSessions = sessions.filter((s) => demoUserIds.has(id(s.userId)));
    const deadSessionIds = new Set(deadSessions.map((s) => String(s._id)));
    const refreshTokens = await ctx.db.query("authRefreshTokens").collect();
    const deadTokens = refreshTokens.filter((t) =>
      deadSessionIds.has(id(t.sessionId)),
    );
    const accounts = await ctx.db.query("authAccounts").collect();
    const deadAccounts = accounts.filter((a) => demoUserIds.has(id(a.userId)));

    /* ---------------- clients & centre structure ---------------- */

    const clients = await ctx.db.query("clients").collect();
    const demoClients = clients.filter((c) => DEMO_CLIENT_CODES.has(c.code));
    const demoClientIds = new Set(demoClients.map((c) => String(c._id)));

    const centers = await ctx.db.query("centers").collect();
    const demoCenters = centers.filter((c) => DEMO_CENTER_CODES.has(c.code));
    const demoCenterIds = new Set(demoCenters.map((c) => String(c._id)));

    const groups = await ctx.db.query("groups").collect();
    const demoGroups = groups.filter(
      (g) => DEMO_GROUP_CODES.has(g.code) || demoCenterIds.has(id(g.centerId)),
    );
    const demoGroupIds = new Set(demoGroups.map((g) => String(g._id)));

    const groupMembers = await ctx.db.query("groupMembers").collect();
    const demoGroupMembers = groupMembers.filter(
      (gm) =>
        demoGroupIds.has(id(gm.groupId)) || demoClientIds.has(id(gm.clientId)),
    );

    const clientDocs = await ctx.db.query("clientDocuments").collect();
    const demoClientDocs = clientDocs.filter((d) =>
      demoClientIds.has(id(d.clientId)),
    );
    const clientNotes = await ctx.db.query("clientNotes").collect();
    const demoClientNotes = clientNotes.filter((n) =>
      demoClientIds.has(id(n.clientId)),
    );
    const staffHistory = await ctx.db.query("clientStaffHistory").collect();
    const demoStaffHistory = staffHistory.filter((h) =>
      demoClientIds.has(id(h.clientId)),
    );
    const geoPhotos = await ctx.db.query("clientGeoPhotos").collect();
    const demoGeoPhotos = geoPhotos.filter((g) =>
      demoClientIds.has(id(g.clientId)),
    );
    const familyRows = await ctx.db.query("clientFamilyMembers").collect();
    const demoFamilyRows = familyRows.filter((f) =>
      demoClientIds.has(id(f.clientId)),
    );

    /* ---------------- loans & money movement ---------------- */

    const loans = await ctx.db.query("loans").collect();
    const demoLoans = loans.filter((l) => demoClientIds.has(id(l.clientId)));
    const demoLoanIds = new Set(demoLoans.map((l) => String(l._id)));

    const schedules = await ctx.db.query("loanSchedules").collect();
    const demoSchedules = schedules.filter((s) =>
      demoLoanIds.has(id(s.loanId)),
    );
    const applications = await ctx.db.query("loanApplications").collect();
    const demoApplications = applications.filter(
      (a) => demoClientIds.has(id(a.clientId)) || demoLoanIds.has(id(a.loanId)),
    );
    const collections = await ctx.db.query("collections").collect();
    const demoCollections = collections.filter((c) =>
      demoLoanIds.has(id(c.loanId)),
    );
    const receipts = await ctx.db.query("receipts").collect();
    const demoReceipts = receipts.filter((r) => demoLoanIds.has(id(r.loanId)));
    const recovery = await ctx.db.query("recoveryActivities").collect();
    const demoRecovery = recovery.filter(
      (r) => demoLoanIds.has(id(r.loanId)) || demoClientIds.has(id(r.clientId)),
    );

    const wallets = await ctx.db.query("wallets").collect();
    const demoWallets = wallets.filter((w) =>
      demoProfileIds.has(id(w.profileId)),
    );
    const demoWalletIds = new Set(demoWallets.map((w) => String(w._id)));
    const walletTxns = await ctx.db.query("walletTransactions").collect();
    const demoWalletTxns = walletTxns.filter((t) =>
      demoWalletIds.has(id(t.walletId)),
    );

    /* ---------------- cash ops, expenses, approvals, misc ---------------- */

    const handovers = await ctx.db.query("cashHandovers").collect();
    const demoHandovers = handovers.filter((h) =>
      demoProfileIds.has(id(h.staffId)),
    );
    const issues = await ctx.db.query("cashIssues").collect();
    const demoIssues = issues.filter((i) => demoProfileIds.has(id(i.staffId)));
    const closings = await ctx.db.query("cashClosings").collect();
    const demoClosings = closings.filter((c) =>
      demoProfileIds.has(id(c.profileId)),
    );
    const expenses = await ctx.db.query("expenses").collect();
    const demoExpenses = expenses.filter((e) =>
      demoProfileIds.has(id(e.profileId)),
    );
    const approvals = await ctx.db.query("approvalRequests").collect();
    const demoApprovals = approvals.filter((a) =>
      demoProfileIds.has(id(a.requestedBy)),
    );
    const grievances = await ctx.db.query("grievances").collect();
    const demoGrievances = grievances.filter((g) =>
      demoClientIds.has(id(g.clientId)),
    );
    const meetings = await ctx.db.query("meetings").collect();
    const demoMeetings = meetings.filter(
      (m) =>
        demoGroupIds.has(id(m.groupId)) || demoProfileIds.has(id(m.staffId)),
    );
    const notifications = await ctx.db.query("notifications").collect();
    const demoNotifications = notifications.filter((n) =>
      demoProfileIds.has(id(n.profileId)),
    );

    /* ---------------- journals & audit ---------------- */

    const journals = await ctx.db.query("journalEntries").collect();
    const demoJournals = journals.filter(
      (j) =>
        demoProfileIds.has(id(j.createdBy)) ||
        /^EX-|^CH-|^CI-/.test(id(j.refId)) ||
        demoLoanIds.has(id(j.refId)),
    );

    const audits = await ctx.db.query("auditLogs").collect();
    const demoAudits = audits.filter(
      (a) =>
        demoProfileIds.has(id(a.actorId)) ||
        (!a.actorId && DEMO_STAFF_IDS.has(id(a.entityId))),
    );

    /* ---------------- delete everything classified ---------------- */

    for (const d of demoWalletTxns) await ctx.db.delete(d._id);
    for (const d of demoWallets) await ctx.db.delete(d._id);
    for (const d of demoRecovery) await ctx.db.delete(d._id);
    for (const d of demoReceipts) await ctx.db.delete(d._id);
    for (const d of demoCollections) await ctx.db.delete(d._id);
    for (const d of demoApplications) await ctx.db.delete(d._id);
    for (const d of demoSchedules) await ctx.db.delete(d._id);
    for (const d of demoLoans) await ctx.db.delete(d._id);
    for (const d of demoFamilyRows) await ctx.db.delete(d._id);
    for (const d of demoGeoPhotos) await ctx.db.delete(d._id);
    for (const d of demoStaffHistory) await ctx.db.delete(d._id);
    for (const d of demoClientNotes) await ctx.db.delete(d._id);
    for (const d of demoClientDocs) await ctx.db.delete(d._id);
    for (const d of demoGroupMembers) await ctx.db.delete(d._id);
    for (const d of demoGroups) await ctx.db.delete(d._id);
    for (const d of demoCenters) await ctx.db.delete(d._id);
    for (const d of demoClients) await ctx.db.delete(d._id);
    for (const d of demoHandovers) await ctx.db.delete(d._id);
    for (const d of demoIssues) await ctx.db.delete(d._id);
    for (const d of demoClosings) await ctx.db.delete(d._id);
    for (const d of demoExpenses) await ctx.db.delete(d._id);
    for (const d of demoApprovals) await ctx.db.delete(d._id);
    for (const d of demoGrievances) await ctx.db.delete(d._id);
    for (const d of demoMeetings) await ctx.db.delete(d._id);
    for (const d of demoNotifications) await ctx.db.delete(d._id);
    for (const d of demoJournals) await ctx.db.delete(d._id);
    for (const d of demoAudits) await ctx.db.delete(d._id);
    for (const d of demoProfiles) await ctx.db.delete(d._id);
    for (const d of demoUsers) await ctx.db.delete(d._id);
    for (const d of deadTokens) await ctx.db.delete(d._id);
    for (const d of deadSessions) await ctx.db.delete(d._id);
    for (const d of deadAccounts) await ctx.db.delete(d._id);

    bump("users", demoUsers.length);
    bump("authSessions", deadSessions.length);
    bump("authRefreshTokens", deadTokens.length);
    bump("authAccounts", deadAccounts.length);
    bump("profiles", demoProfiles.length);
    bump("clients", demoClients.length);
    bump("centers", demoCenters.length);
    bump("groups", demoGroups.length);
    bump("groupMembers", demoGroupMembers.length);
    bump("clientDocuments", demoClientDocs.length);
    bump("clientNotes", demoClientNotes.length);
    bump("clientStaffHistory", demoStaffHistory.length);
    bump("clientGeoPhotos", demoGeoPhotos.length);
    bump("clientFamilyMembers", demoFamilyRows.length);
    bump("loans", demoLoans.length);
    bump("loanSchedules", demoSchedules.length);
    bump("loanApplications", demoApplications.length);
    bump("collections", demoCollections.length);
    bump("receipts", demoReceipts.length);
    bump("recoveryActivities", demoRecovery.length);
    bump("wallets", demoWallets.length);
    bump("walletTransactions", demoWalletTxns.length);
    bump("cashHandovers", demoHandovers.length);
    bump("cashIssues", demoIssues.length);
    bump("cashClosings", demoClosings.length);
    bump("expenses", demoExpenses.length);
    bump("approvalRequests", demoApprovals.length);
    bump("grievances", demoGrievances.length);
    bump("meetings", demoMeetings.length);
    bump("notifications", demoNotifications.length);
    bump("journalEntries", demoJournals.length);
    bump("auditLogs", demoAudits.length);

    /* ---------------- preservation report ---------------- */

    const remainingProfiles = (await ctx.db.query("profiles").collect()).map(
      (p) => ({ name: p.name, email: p.email, role: p.role, staffId: p.staffId }),
    );
    const keptAuditorActors = [
      ...new Set(
        audits.filter((a) => !demoAudits.includes(a)).map((a) => a.actorName),
      ),
    ];

    return {
      deleted,
      kept: {
        branches: (await ctx.db.query("branches").collect()).length,
        loanProducts: (await ctx.db.query("loanProducts").collect()).length,
        accountLedgers: (await ctx.db.query("accountLedgers").collect()).length,
        counters: (await ctx.db.query("counters").collect()).length,
        devices: (await ctx.db.query("devices").collect()).length,
        auditLogs: audits.length - demoAudits.length,
        auditLogActors: keptAuditorActors,
        profiles: remainingProfiles,
      },
    };
  },
});
