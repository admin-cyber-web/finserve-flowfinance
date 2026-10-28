import { internalQuery } from "./_generated/server";

/** TEMPORARY (delete after use): dump org/approval/loan state for the fresh-start task. */
export const dump = internalQuery({
  args: {},
  handler: async (ctx) => {
    const [branches, profiles, products, loans, apps, approvals, counters, clients] =
      await Promise.all([
        ctx.db.query("branches").collect(),
        ctx.db.query("profiles").collect(),
        ctx.db.query("loanProducts").collect(),
        ctx.db.query("loans").collect(),
        ctx.db.query("loanApplications").collect(),
        ctx.db.query("approvalRequests").collect(),
        ctx.db.query("counters").collect(),
        ctx.db.query("clients").collect(),
      ]);

    return {
      branches: branches.map((b) => ({
        id: b._id, code: b.code, name: b.name, city: b.city, status: b.status,
      })),
      profiles: profiles.map((p) => ({
        id: p._id, name: p.name, staffId: p.staffId, role: p.role, status: p.status,
        branchId: p.branchId, userId: p.userId, persona: p.persona, clientId: p.clientId,
      })),
      products: products.map((p) => ({
        id: p._id, code: p.code, name: p.name, min: p.minAmount, max: p.maxAmount,
        rate: p.interestRate, method: p.interestMethod, tenure: p.tenure,
        freq: p.frequency, fee: p.processingFee, status: p.status,
      })),
      loans: loans.map((l) => ({
        id: l._id, loanId: l.loanId, clientId: l.clientId, principal: l.principal,
        status: l.status, outstanding: l.outstanding, paidTotal: l.paidTotal,
        archivedAt: l.archivedAt, closedAt: l.closeDate, createdAt: l.createdAt,
      })),
      apps: apps.map((a) => ({
        id: a._id, appId: a.appId, clientId: a.clientId, status: a.status,
        amount: a.amount, loanId: a.loanId, createdAt: a.createdAt,
        history: a.history.map((h) => `${h.actorName}:${h.action}`),
      })),
      approvals: approvals.map((a) => ({
        id: a._id, kind: a.kind, refId: a.refId, status: a.status, amount: a.amount,
        summary: a.summary, createdAt: a.createdAt,
      })),
      counters: counters.map((c) => ({ key: c.key, value: c.value })),
      clientCount: clients.length,
      clientSample: clients.slice(0, 15).map((c) => ({
        id: c._id, code: c.code, name: c.name, status: c.status,
      })),
      targetClients: clients
        .filter((c) => c.code === "C-000137" || c.code === "C-000133")
        .map((c) => ({ id: c._id, code: c.code, name: c.name })),
    };
  },
});
